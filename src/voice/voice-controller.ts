import { Events } from '../events';
import { VoiceCommands } from './voice-commands';

const SILENCE_THRESHOLD = 0.01;
const SILENCE_DURATION_MS = 2000;
const ANALYSIS_INTERVAL_MS = 100;

class VoiceController {
    private events: Events;
    private commands: VoiceCommands;
    private apiKey: string;

    private stream: MediaStream | null = null;
    private recorder: MediaRecorder | null = null;
    private chunks: Blob[] = [];
    private active = false;

    // Silence detection
    private audioContext: AudioContext | null = null;
    private analyser: AnalyserNode | null = null;
    private silenceTimer: ReturnType<typeof setTimeout> | null = null;
    private analysisInterval: ReturnType<typeof setInterval> | null = null;
    private hasSpoken = false;

    constructor(events: Events) {
        this.events = events;
        const config = (window as any).supersplatConfig ?? {};
        this.apiKey = config.openaiApiKey || '';
        this.commands = new VoiceCommands(events, this.apiKey);

        events.on('voice.toggle', () => this.toggle());

        // Hold-to-talk: space key fires voice.hold with down=true/false
        events.on('voice.hold', (down: boolean) => {
            if (down && !this.active) {
                this.start();
            } else if (!down && this.active) {
                this.stop();
            }
        });

        // Direct space key listener as fallback — the shortcut system may miss
        // space if document.body doesn't have focus (e.g. after clicking a button)
        const isInputFocused = () => {
            const tag = document.activeElement?.tagName;
            return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT';
        };

        document.addEventListener('keydown', (e) => {
            if (e.key === ' ' && !e.repeat && !isInputFocused()) {
                e.preventDefault();
                if (!this.active) this.start();
            }
        });

        document.addEventListener('keyup', (e) => {
            if (e.key === ' ' && !isInputFocused()) {
                if (this.active) this.stop();
            }
        });
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
            this.hasSpoken = false;
            this.recorder = new MediaRecorder(this.stream, { mimeType: 'audio/webm;codecs=opus' });

            this.recorder.ondataavailable = (e) => {
                if (e.data.size > 0) {
                    this.chunks.push(e.data);
                }
            };

            this.recorder.onstop = () => {
                this.transcribe();
            };

            // Request data every 250ms so we accumulate chunks while recording
            this.recorder.start(250);
            this.active = true;
            this.events.fire('voice.active', true);

            // Set up silence detection
            this.startSilenceDetection();

            console.log('[VoiceController] Recording started (auto-stop on silence)');

        } catch (err) {
            console.error('[VoiceController] Start failed:', err);
            this.cleanup();
        }
    }

    private startSilenceDetection() {
        if (!this.stream) return;

        this.audioContext = new AudioContext();
        const source = this.audioContext.createMediaStreamSource(this.stream);
        this.analyser = this.audioContext.createAnalyser();
        this.analyser.fftSize = 512;
        source.connect(this.analyser);

        const dataArray = new Float32Array(this.analyser.fftSize);

        this.analysisInterval = setInterval(() => {
            if (!this.analyser) return;

            this.analyser.getFloatTimeDomainData(dataArray);

            // RMS volume
            let sum = 0;
            for (let i = 0; i < dataArray.length; i++) {
                sum += dataArray[i] * dataArray[i];
            }
            const rms = Math.sqrt(sum / dataArray.length);

            if (rms > SILENCE_THRESHOLD) {
                // Sound detected
                this.hasSpoken = true;
                if (this.silenceTimer) {
                    clearTimeout(this.silenceTimer);
                    this.silenceTimer = null;
                }
            } else if (this.hasSpoken && !this.silenceTimer) {
                // Silence after speech — start countdown
                this.silenceTimer = setTimeout(() => {
                    console.log('[VoiceController] Silence detected, auto-stopping');
                    this.stop();
                }, SILENCE_DURATION_MS);
            }
        }, ANALYSIS_INTERVAL_MS);
    }

    private stop() {
        this.stopSilenceDetection();

        if (this.recorder && this.recorder.state === 'recording') {
            this.recorder.stop(); // triggers onstop → transcribe()
        }
        this.active = false;
        this.events.fire('voice.active', false);
        console.log('[VoiceController] Recording stopped');
    }

    private stopSilenceDetection() {
        if (this.analysisInterval) {
            clearInterval(this.analysisInterval);
            this.analysisInterval = null;
        }
        if (this.silenceTimer) {
            clearTimeout(this.silenceTimer);
            this.silenceTimer = null;
        }
        if (this.audioContext) {
            this.audioContext.close();
            this.audioContext = null;
        }
        this.analyser = null;
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
        this.stopSilenceDetection();
        if (this.stream) {
            this.stream.getTracks().forEach(t => t.stop());
            this.stream = null;
        }
        this.recorder = null;
    }
}

export { VoiceController };
