import { Events } from '../events';
import { VoiceCommands } from './voice-commands';

const SILENCE_THRESHOLD = 0.01;
const SILENCE_DURATION_MS = 2000;
const ANALYSIS_INTERVAL_MS = 100;
const WAKE_WORD = 'computer';

declare global {
    interface Window {
        SpeechRecognition: typeof SpeechRecognition;
        webkitSpeechRecognition: typeof SpeechRecognition;
    }
}

class VoiceController {
    private events: Events;
    private commands: VoiceCommands;
    private apiKey: string;
    private proxyBaseUrl: string;

    // Recording state
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

    // Wake word listener
    private recognition: SpeechRecognition | null = null;
    private listening = false;
    private lastWakeTriggerAt = 0;

    constructor(events: Events) {
        this.events = events;
        const config = (window as any).supersplatConfig ?? {};
        this.apiKey = config.openaiApiKey || '';
        this.proxyBaseUrl = this.resolveProxyBaseUrl(config.openAiProxyBaseUrl);
        this.commands = new VoiceCommands(events, this.apiKey, this.proxyBaseUrl);

        events.on('voice.toggle', () => this.toggle());
        events.on('voice.toggleWakeWord', () => this.toggleWakeWord());

        // Hold-to-talk: space key fires voice.hold with down=true/false
        events.on('voice.hold', (down: boolean) => {
            if (down && !this.active) {
                this.start();
            } else if (!down && this.active) {
                this.stop();
            }
        });

        // Direct space key listener as fallback
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

    // --- Wake word mode ---

    private toggleWakeWord() {
        if (this.listening) {
            this.stopWakeWordListener();
        } else {
            this.startWakeWordListener();
        }
    }

    private startWakeWordListener() {
        const SpeechRecognitionClass = (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition;
        if (!SpeechRecognitionClass) {
            console.error('[VoiceController] SpeechRecognition not supported — wake word requires Chrome');
            return;
        }

        this.recognition = new SpeechRecognitionClass();
        this.recognition.continuous = true;
        this.recognition.interimResults = true;
        this.recognition.lang = 'en-US';

        this.recognition.onresult = (event: SpeechRecognitionEvent) => {
            // Already recording — ignore any interim results
            if (this.active) return;

            // Short cooldown after a trigger prevents the same phrase from re-firing
            // across consecutive interim-result events
            const now = Date.now();
            if (now - this.lastWakeTriggerAt < 2000) return;

            for (let i = event.resultIndex; i < event.results.length; i++) {
                const result = event.results[i];
                const text = result[0].transcript.toLowerCase().trim();

                // Only accept final results OR interim results where wake word is the ENTIRE utterance so far.
                // This avoids "the computer program" triggering — interim would have more words, final would too.
                const tokens = text.split(/\s+/).filter(Boolean);
                if (tokens.length === 0) continue;

                // Fire only when "computer" is the first word spoken.
                // This is the natural way to invoke a voice assistant and drastically reduces false triggers.
                if (tokens[0] !== WAKE_WORD) continue;

                // Require the result to be final (or a stable interim with only the wake word)
                // so we don't fire mid-sentence on a partial "computer..."
                if (!result.isFinal && tokens.length > 1) continue;

                console.log(`[VoiceController] Wake word detected: "${text}" (final: ${result.isFinal})`);
                this.lastWakeTriggerAt = now;
                this.pauseWakeWordListener();
                this.start();
                return;
            }
        };

        this.recognition.onend = () => {
            // Auto-restart if still in listening mode (recognition stops randomly)
            if (this.listening && !this.active) {
                try {
                    this.recognition?.start();
                } catch { /* already started */ }
            }
        };

        this.recognition.onerror = (event: SpeechRecognitionErrorEvent) => {
            // 'no-speech' and 'aborted' are normal — just restart
            if (event.error === 'no-speech' || event.error === 'aborted') return;
            console.warn('[VoiceController] Recognition error:', event.error);
        };

        try {
            this.recognition.start();
            this.listening = true;
            this.events.fire('voice.listening', true);
            console.log('[VoiceController] Wake word listener active — say "Computer" to start');
        } catch (err) {
            console.error('[VoiceController] Failed to start wake word listener:', err);
        }
    }

    private pauseWakeWordListener() {
        if (this.recognition) {
            try {
                this.recognition.stop();
            } catch { /* already stopped */ }
        }
    }

    private stopWakeWordListener() {
        this.listening = false;
        if (this.recognition) {
            try {
                this.recognition.stop();
            } catch { /* already stopped */ }
            this.recognition = null;
        }
        this.events.fire('voice.listening', false);
        console.log('[VoiceController] Wake word listener stopped');
    }

    private resumeWakeWordListener() {
        if (this.listening && this.recognition && !this.active) {
            try {
                this.recognition.start();
            } catch { /* already started */ }
        }
    }

    // --- Recording mode ---

    private async start() {
        if (this.active) {
            console.log('[VoiceController] start() ignored — already recording');
            return;
        }
        if (!this.hasOpenAiAccess()) {
            console.error('[VoiceController] No OpenAI API key configured');
            return;
        }

        // Flip active immediately to prevent re-entrant start() calls while getUserMedia is awaiting
        this.active = true;

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

            // Pick a supported mime type — webm/opus is preferred, mp4/aac as fallback
            const mimeType = MediaRecorder.isTypeSupported('audio/webm;codecs=opus') ?
                'audio/webm;codecs=opus' :
                MediaRecorder.isTypeSupported('audio/webm') ?
                    'audio/webm' :
                    MediaRecorder.isTypeSupported('audio/mp4') ?
                        'audio/mp4' :
                        '';
            this.recorder = new MediaRecorder(this.stream, mimeType ? { mimeType } : {});

            this.recorder.ondataavailable = (e) => {
                if (e.data.size > 0) {
                    this.chunks.push(e.data);
                }
            };

            this.recorder.onstop = () => {
                this.transcribe();
            };

            // Don't use timeslice — request a single blob on stop for cleaner output
            this.recorder.start();
            this.events.fire('voice.active', true);

            this.startSilenceDetection();

            console.log(`[VoiceController] Recording started — requested: "${mimeType}", recorder.mimeType: "${this.recorder.mimeType}"`);

        } catch (err) {
            console.error('[VoiceController] Start failed:', err);
            this.active = false;
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

            let sum = 0;
            for (let i = 0; i < dataArray.length; i++) {
                sum += dataArray[i] * dataArray[i];
            }
            const rms = Math.sqrt(sum / dataArray.length);

            if (rms > SILENCE_THRESHOLD) {
                this.hasSpoken = true;
                if (this.silenceTimer) {
                    clearTimeout(this.silenceTimer);
                    this.silenceTimer = null;
                }
            } else if (this.hasSpoken && !this.silenceTimer) {
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
            this.recorder.stop();
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

    // --- Transcription ---

    private async transcribe() {
        if (this.chunks.length === 0) {
            this.cleanup();
            this.resumeWakeWordListener();
            return;
        }

        // Prefer the recorder's authoritative mimeType over the first chunk's type
        const recorderMime = this.recorder?.mimeType || '';
        const chunkMime = this.chunks[0]?.type || '';
        const actualMime = recorderMime || chunkMime || 'audio/webm';
        const blob = new Blob(this.chunks, { type: actualMime });
        console.log(`[VoiceController] Blob built — size: ${blob.size}, recorderMime: "${recorderMime}", chunkMime: "${chunkMime}", blob.type: "${blob.type}", chunks: ${this.chunks.length}`);
        this.chunks = [];
        this.cleanup();

        if (blob.size < 5000) {
            console.log('[VoiceController] Recording too short, skipping');
            this.resumeWakeWordListener();
            return;
        }

        this.events.fire('voice.transcribing', true);

        // Pick filename extension matching the actual format.
        // Whisper picks the decoder based on the filename extension, so the extension MUST match the container.
        const mimeLower = actualMime.toLowerCase();
        const ext = mimeLower.includes('mp4') || mimeLower.includes('m4a') || mimeLower.includes('aac') ?
            'mp4' :
            mimeLower.includes('ogg') ?
                'ogg' :
                mimeLower.includes('wav') ?
                    'wav' :
                    'webm';

        console.log(`[VoiceController] Uploading as recording.${ext} (mime: ${actualMime}, size: ${blob.size}B)`);

        try {
            const formData = new FormData();
            formData.append('file', blob, `recording.${ext}`);
            formData.append('model', 'gpt-4o-mini-transcribe');
            formData.append('response_format', 'text');

            let response = await fetch(this.openAiTranscriptionsUrl(), {
                method: 'POST',
                headers: this.openAiFormHeaders(),
                body: formData
            });

            // Fallback to whisper-1 if the audio format isn't supported
            if (response.status === 400) {
                const firstErr = await response.text();
                console.log(`[VoiceController] gpt-4o-mini-transcribe rejected audio (${firstErr}), retrying with whisper-1`);
                const fallbackForm = new FormData();
                fallbackForm.append('file', blob, `recording.${ext}`);
                fallbackForm.append('model', 'whisper-1');
                fallbackForm.append('response_format', 'text');

                response = await fetch(this.openAiTranscriptionsUrl(), {
                    method: 'POST',
                    headers: this.openAiFormHeaders(),
                    body: fallbackForm
                });
            }

            if (!response.ok) {
                const errText = await response.text();
                // Expose blob so user can inspect/download it in DevTools if needed
                (window as any).__lastVoiceBlob = blob;
                console.error(`[VoiceController] Blob saved to window.__lastVoiceBlob for inspection (size: ${blob.size}, type: ${blob.type})`);
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
            this.resumeWakeWordListener();
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

    private hasOpenAiAccess() {
        return !!this.apiKey || !!this.proxyBaseUrl;
    }

    private resolveProxyBaseUrl(configured?: string) {
        if (configured) {
            return configured.replace(/\/$/, '');
        }
        if (/^board-demo-editor(?:-[a-z0-9-]+)?\.vercel\.app$/i.test(window.location.hostname)) {
            return window.location.origin;
        }
        return '';
    }

    private openAiTranscriptionsUrl() {
        return this.proxyBaseUrl ?
            `${this.proxyBaseUrl}/api/openai/audio/transcriptions` :
            'https://api.openai.com/v1/audio/transcriptions';
    }

    private openAiFormHeaders() {
        return this.proxyBaseUrl ? {} : { Authorization: `Bearer ${this.apiKey}` };
    }
}

export { VoiceController };
