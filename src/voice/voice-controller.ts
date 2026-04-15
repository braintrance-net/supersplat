import { Events } from '../events';
import { VoiceCommands } from './voice-commands';

const REALTIME_MODEL = 'gpt-4o-mini-realtime-preview';

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
            // Step 1: Create an ephemeral session token
            const sessionResponse = await fetch('https://api.openai.com/v1/realtime/sessions', {
                method: 'POST',
                headers: {
                    'Authorization': `Bearer ${this.apiKey}`,
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({
                    model: REALTIME_MODEL,
                    modalities: ['text', 'audio'],
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

            if (!sessionResponse.ok) {
                const errText = await sessionResponse.text();
                throw new Error(`Session creation failed: ${sessionResponse.status} ${errText}`);
            }

            const sessionData = await sessionResponse.json();
            const ephemeralKey = sessionData.client_secret?.value;
            if (!ephemeralKey) {
                throw new Error('No ephemeral key in session response');
            }

            console.log('[VoiceController] Got ephemeral key');

            // Step 2: Get microphone
            this.stream = await navigator.mediaDevices.getUserMedia({
                audio: {
                    echoCancellation: true,
                    noiseSuppression: true,
                    channelCount: 1
                }
            });

            // Step 3: Create WebRTC peer connection
            this.pc = new RTCPeerConnection();

            // Add audio track
            this.stream.getAudioTracks().forEach(track => {
                this.pc!.addTrack(track, this.stream!);
            });

            // Add a silent audio receiver so we get the remote audio track
            // (required even if we only care about transcription)
            this.pc.addTransceiver('audio', { direction: 'sendrecv' });

            // Set up data channel for events
            this.dc = this.pc.createDataChannel('oai-events');
            this.dc.onmessage = (event) => this.handleDataChannelMessage(event);

            // Step 4: Create offer and exchange SDP with ephemeral key
            const offer = await this.pc.createOffer();
            await this.pc.setLocalDescription(offer);

            const connectResponse = await fetch(`https://api.openai.com/v1/realtime?model=${REALTIME_MODEL}`, {
                method: 'POST',
                headers: {
                    'Authorization': `Bearer ${ephemeralKey}`,
                    'Content-Type': 'application/sdp'
                },
                body: offer.sdp
            });

            if (!connectResponse.ok) {
                const errText = await connectResponse.text();
                throw new Error(`WebRTC connect failed: ${connectResponse.status} ${errText}`);
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
