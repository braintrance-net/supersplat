import { Events } from '../events';
import { VoiceCommands } from './voice-commands';

class VoiceController {
    private events: Events;
    private commands: VoiceCommands;
    private apiKey: string;

    private pc: RTCPeerConnection | null = null;
    private dc: RTCDataChannel | null = null;
    private stream: MediaStream | null = null;
    private active = false;

    constructor(events: Events) {
        this.events = events;
        const config = (window as any).supersplatConfig ?? {};
        this.apiKey = config.openaiApiKey || '';
        this.commands = new VoiceCommands(events, this.apiKey);

        events.on('voice.toggle', () => this.toggle());
    }

    toggle() {
        if (this.active) {
            this.stop();
        } else {
            this.start();
        }
    }

    private async start() {
        if (!this.apiKey) {
            console.error('[VoiceController] No OpenAI API key configured');
            return;
        }

        try {
            // Get microphone
            this.stream = await navigator.mediaDevices.getUserMedia({
                audio: {
                    echoCancellation: true,
                    noiseSuppression: true,
                    channelCount: 1
                }
            });

            // Create peer connection
            this.pc = new RTCPeerConnection();

            // Add audio track
            this.stream.getAudioTracks().forEach(track => {
                this.pc!.addTrack(track, this.stream!);
            });

            // Set up data channel for events
            this.dc = this.pc.createDataChannel('oai-events');
            this.dc.onmessage = (event) => this.handleDataChannelMessage(event);

            // Create and set local offer
            const offer = await this.pc.createOffer();
            await this.pc.setLocalDescription(offer);

            // Send SDP to OpenAI Realtime API
            const sdpResponse = await fetch('https://api.openai.com/v1/realtime/sessions', {
                method: 'POST',
                headers: {
                    'Authorization': `Bearer ${this.apiKey}`,
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({
                    model: 'gpt-4o-mini-transcribe',
                    voice: 'ash',
                    modalities: ['text'],
                    input_audio_transcription: {
                        model: 'gpt-4o-mini-transcribe'
                    },
                    turn_detection: {
                        type: 'server_vad',
                        threshold: 0.5,
                        prefix_padding_ms: 300,
                        silence_duration_ms: 700
                    }
                })
            });

            if (!sdpResponse.ok) {
                throw new Error(`Realtime session failed: ${sdpResponse.status}`);
            }

            const sessionData = await sdpResponse.json();

            // Now connect via WebRTC with the ephemeral key
            const ephemeralKey = sessionData.client_secret?.value;
            if (!ephemeralKey) {
                throw new Error('No ephemeral key in session response');
            }

            // Create a new peer connection for the actual WebRTC session
            this.pc.close();
            this.pc = new RTCPeerConnection();

            this.stream.getAudioTracks().forEach(track => {
                this.pc!.addTrack(track, this.stream!);
            });

            this.dc = this.pc.createDataChannel('oai-events');
            this.dc.onmessage = (event) => this.handleDataChannelMessage(event);

            const offer2 = await this.pc.createOffer();
            await this.pc.setLocalDescription(offer2);

            // Exchange SDP with the realtime endpoint using ephemeral key
            const connectResponse = await fetch('https://api.openai.com/v1/realtime?model=gpt-4o-mini-transcribe', {
                method: 'POST',
                headers: {
                    'Authorization': `Bearer ${ephemeralKey}`,
                    'Content-Type': 'application/sdp'
                },
                body: offer2.sdp
            });

            if (!connectResponse.ok) {
                throw new Error(`WebRTC connect failed: ${connectResponse.status}`);
            }

            const answerSdp = await connectResponse.text();
            await this.pc.setRemoteDescription({
                type: 'answer',
                sdp: answerSdp
            });

            this.active = true;
            this.events.fire('voice.active', true);
            console.log('[VoiceController] Started');

        } catch (err) {
            console.error('[VoiceController] Start failed:', err);
            this.cleanup();
        }
    }

    private stop() {
        this.cleanup();
        this.active = false;
        this.events.fire('voice.active', false);
        console.log('[VoiceController] Stopped');
    }

    private cleanup() {
        if (this.dc) {
            this.dc.close();
            this.dc = null;
        }
        if (this.pc) {
            this.pc.close();
            this.pc = null;
        }
        if (this.stream) {
            this.stream.getTracks().forEach(t => t.stop());
            this.stream = null;
        }
    }

    private handleDataChannelMessage(event: MessageEvent) {
        try {
            const msg = JSON.parse(event.data);

            if (msg.type === 'conversation.item.input_audio_transcription.completed') {
                const transcript = msg.transcript?.trim();
                if (transcript) {
                    console.log(`[VoiceController] Transcript: "${transcript}"`);
                    this.events.fire('voice.transcript', transcript);
                    this.commands.processTranscript(transcript);
                }
            }
        } catch (err) {
            // Ignore non-JSON or unknown messages
        }
    }
}

export { VoiceController };
