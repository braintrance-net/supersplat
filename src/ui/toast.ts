import { Events } from '../events';

type ToastType = 'info' | 'warning' | 'error' | 'success';

interface ToastOptions {
    message: string;
    type?: ToastType;
    duration?: number;
}

const TOAST_DURATION = 3000;
const TOAST_ANIMATION = 300;

class ToastManager {
    private container: HTMLDivElement;

    constructor(events: Events) {
        this.container = document.createElement('div');
        this.container.id = 'toast-container';
        document.body.appendChild(this.container);

        events.on('toast', (message: string, type?: ToastType, duration?: number) => {
            this.show({ message, type: type ?? 'info', duration: duration ?? TOAST_DURATION });
        });
    }

    private show(options: ToastOptions) {
        const toast = document.createElement('div');
        toast.className = `toast toast-${options.type ?? 'info'}`;

        const icon = document.createElement('span');
        icon.className = 'toast-icon';
        icon.textContent = this.getIcon(options.type ?? 'info');

        const text = document.createElement('span');
        text.className = 'toast-message';
        text.textContent = options.message;

        toast.appendChild(icon);
        toast.appendChild(text);
        this.container.appendChild(toast);

        // trigger enter animation
        requestAnimationFrame(() => toast.classList.add('toast-visible'));

        const dismiss = () => {
            toast.classList.remove('toast-visible');
            toast.classList.add('toast-exit');
            setTimeout(() => toast.remove(), TOAST_ANIMATION);
        };

        setTimeout(dismiss, options.duration ?? TOAST_DURATION);
        toast.addEventListener('click', dismiss);
    }

    private getIcon(type: ToastType): string {
        switch (type) {
            case 'error': return '✕';
            case 'warning': return '!';
            case 'success': return '✓';
            case 'info': default: return 'ℹ';
        }
    }
}

export { ToastManager };
