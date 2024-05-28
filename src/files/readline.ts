import { Writable } from 'stream';

const LF = '\n'.charCodeAt(0);

export class Readline extends Writable {
    #buff: Buffer = Buffer.alloc(0);
    _write(chunk: any, _: BufferEncoding, callback: (error?: Error | null | undefined) => void): void {
        this.#buff = Buffer.concat([this.#buff, Buffer.from(chunk)]);
        let lf = this.#buff.indexOf(LF);
        while (lf >= 0) {
            const buff = this.#buff.subarray(0, lf);
            this.#buff = this.#buff.subarray(lf + 1);
            if (buff.length) this.emit('line', buff.toString('utf8'));
            lf = this.#buff.indexOf(LF);
        }
        callback();
    }
}
