import { Events } from '../events';
import { VoiceCommands } from './voice-commands';

class VoiceController {
    private events: Events;
    private commands: VoiceCommands;
    private apiKey: string;

    private stream: MediaStream | null = null;
    private recorder: MediaRecorder | null = null;
    private chunks: Blob[] = [];
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
            this.stream = await navigator.mediaDevices.getUserMedia({
                audio: {
                    echoCancellation: true,
                    noiseSuppression: true,
                    channelCount: 1
                }
            });

            this.chunks = [];
            this.recorder = new MediaRecorder(this.stream, { mimeType: 'audio/webm;codecs=opus' });

            this.recorder.ondataavailable = (e) => {
                if (e.data.size > 0) {
                    this.chunks.push(e.data);
                }
            };

            this.recorder.onstop = () => {
                this.transcribe();
            };

            this.recorder.start();
            this.active = true;
            this.events.fire('voice.active', true);
            console.log('[VoiceController] Recording started');

        } catch (err) {
            console.error('[VoiceController] Start failed:', err);
            this.cleanup();
        }
    }

    private stop() {
        if (this.recorder && this.recorder.state === 'recording') {
            this.recorder.stop(); // triggers onstop → transcribe()
        }
        this.active = false;
        this.events.fire('voice.active', false);
        console.log('[VoiceController] Recording stopped');
    }

    private async transcribe() {
        if (this.chunks.length === 0) {
            this.cleanup();
            return;
        }

        const blob = new Blob(this.chunks, { type: 'audio/webm' });
        this.chunks = [];
        this.cleanup();

        // Skip tiny recordings (< 0.5s of audio is usually noise)
        if (blob.size < 5000) {
            console.log('[VoiceController] Recording too short, skipping');
            return;
        }

        this.events.fire('voice.transcribing', true);

        try {
            const formData = new FormData();
            formData.append('file', blob, 'recording.webm');
            formData.append('model', 'gpt-4o-mini-transcribe');
            formData.append('response_format', 'text');

            const response = await fetch('https://api.openai.com/v1/audio/transcriptions', {
                method: 'POST',
                headers: {
                    'Authorization': `Bearer ${this.apiKey}`
                },
                body: formData
            });

            if (!response.ok) {
                const errText = await response.text();
                throw new Error(`Transcription failed: ${response.status} ${errText}`);
            }

            const transcript = (await response.text()).trim();
            if (transcript) {
                console.log(`[VoiceController] Transcript: "${transcript}"`);
                this.events.fire('voice.transcript', transcript);
                await this.commands.processTranscript(transcript);
            }
        } catch (err) {
            console.error('[VoiceController] Transcription failed:', err);
        } finally {
            this.events.fire('voice.transcribing', false);
        }
    }

    private cleanup() {
        if (this.stream) {
            this.stream.getTracks().forEach(t => t.stop());
            this.stream = null;
        }
        this.recorder = null;
    }
}

export { VoiceController };
