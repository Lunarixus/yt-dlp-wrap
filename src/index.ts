import { EventEmitter } from 'events';
import {
    ChildProcess,
    ChildProcessWithoutNullStreams,
    execFile,
    ExecFileException,
    spawn,
    SpawnOptionsWithoutStdio,
} from 'child_process';
import fs from 'fs';
import https from 'https';
import os from 'os';
import { Readable } from 'stream';
import { IncomingMessage } from 'http';

const executableName = 'yt-dlp';
const progressRegex = /\[download\] *(.*) of ([^ ]*)(:? *at *([^ ]*))?(:? *ETA *([^ ]*))?/;

export interface YTDlpEventEmitter extends EventEmitter {
    ytDlpProcess?: ChildProcessWithoutNullStreams;
}

export interface YTDlpPromise<T> extends Promise<T> {
    ytDlpProcess?: ChildProcess;
}

export interface YTDlpReadable extends Readable {
    ytDlpProcess?: ChildProcessWithoutNullStreams;
}

export interface YTDlpOptions extends SpawnOptionsWithoutStdio {
    maxBuffer?: number;
}

export interface Progress {
    percent?: number;
    totalSize?: string;
    currentSpeed?: string;
    eta?: string;
}

export default class YTDlpWrap {
    private binaryPath: string;

    constructor(binaryPath: string = executableName) {
        this.binaryPath = binaryPath;
    }

    getBinaryPath(): string {
        return this.binaryPath;
    }

    setBinaryPath(binaryPath: string) {
        this.binaryPath = binaryPath;
    }

    private static createGetMessage(url: string): Promise<IncomingMessage> {
        return new Promise<IncomingMessage>((resolve, reject) => {
            https.get(url, (httpResponse) => {
                httpResponse.on('error', (e) => reject(e));
                resolve(httpResponse);
            });
        });
    }

    private static processMessageToFile(
        message: IncomingMessage,
        filePath: string
    ): Promise<IncomingMessage> {
        return new Promise<IncomingMessage>((resolve, reject) => {
            message.pipe(fs.createWriteStream(filePath));
            message.on('error', (e) => reject(e));
            message.on('end', () =>
                message.statusCode == 200 ? resolve(message) : reject(message)
            );
        });
    }

    static async downloadFile(
        fileURL: string,
        filePath: string
    ): Promise<IncomingMessage | undefined> {
        let currentUrl: string | null = fileURL;
        while (currentUrl) {
            const message: IncomingMessage = await YTDlpWrap.createGetMessage(
                currentUrl
            );

            if (message.headers.location) {
                currentUrl = message.headers.location;
            } else {
                return await YTDlpWrap.processMessageToFile(message, filePath);
            }
        }
    }

    static getGithubReleases(page = 1, perPage = 1): Promise<any> {
        return new Promise<any>((resolve, reject) => {
            const apiURL =
                'https://api.github.com/repos/yt-dlp/yt-dlp/releases?page=' +
                page +
                '&per_page=' +
                perPage;
            https.get(
                apiURL,
                { headers: { 'User-Agent': 'node' } },
                (response) => {
                    let resonseString = '';
                    response.setEncoding('utf8');
                    response.on('data', (body) => (resonseString += body));
                    response.on('error', (e) => reject(e));
                    response.on('end', () =>
                        response.statusCode == 200
                            ? resolve(JSON.parse(resonseString))
                            : reject(response)
                    );
                }
            );
        });
    }

    static async downloadFromGithub(
        filePath?: string,
        version?: string,
        platform = os.platform()
    ): Promise<void> {
        const isWin32 = platform == 'win32';
        let fileName = `${executableName}${isWin32 ? '.exe' : ''}`;
        if (!version)
            version = (await YTDlpWrap.getGithubReleases(1, 1))[0].tag_name;
        if (!filePath) filePath = './' + fileName;
        let fileURL =
            'https://github.com/yt-dlp/yt-dlp/releases/download/' +
            version +
            '/' +
            fileName;
        await YTDlpWrap.downloadFile(fileURL, filePath);
        isWin32 && fs.chmodSync(filePath, '070');
    }

    exec(
        ytDlpArguments: string[] = [],
        options: YTDlpOptions = {},
        abortSignal: AbortSignal | null = null
    ): YTDlpEventEmitter {
        options = YTDlpWrap.setDefaultOptions(options);
        const execEventEmitter: YTDlpEventEmitter = new EventEmitter();
        const ytDlpProcess = spawn(this.binaryPath, ytDlpArguments, options);
        execEventEmitter.ytDlpProcess = ytDlpProcess;
        YTDlpWrap.bindAbortSignal(abortSignal, ytDlpProcess);

        let stderrData = '';
        let processError: Error;
        ytDlpProcess.stdout.on('data', (data) =>
            YTDlpWrap.emitYoutubeDlEvents(data.toString(), execEventEmitter)
        );
        ytDlpProcess.stderr.on(
            'data',
            (data) => (stderrData += data.toString())
        );
        ytDlpProcess.on('error', (error) => (processError = error));

        ytDlpProcess.on('close', (code) => {
            if (code === 0 || ytDlpProcess.killed)
                execEventEmitter.emit('close', code);
            else
                execEventEmitter.emit(
                    'error',
                    YTDlpWrap.createError(code, processError, stderrData)
                );
        });
        return execEventEmitter;
    }

    execPromise(
        ytDlpArguments: string[] = [],
        options: YTDlpOptions = {},
        abortSignal: AbortSignal | null = null
    ): YTDlpPromise<string> {
        let ytDlpProcess: ChildProcess | undefined;
        const ytDlpPromise: YTDlpPromise<string> = new Promise(
            (resolve, reject) => {
                options = YTDlpWrap.setDefaultOptions(options);
                ytDlpProcess = execFile(
                    this.binaryPath,
                    ytDlpArguments,
                    options,
                    (error, stdout, stderr) => {
                        if (error)
                            reject(YTDlpWrap.createError(error, null, stderr));
                        resolve(stdout);
                    }
                );
                YTDlpWrap.bindAbortSignal(abortSignal, ytDlpProcess);
            }
        );

        ytDlpPromise.ytDlpProcess = ytDlpProcess;
        return ytDlpPromise;
    }

    execStream(
        ytDlpArguments: string[] = [],
        options: YTDlpOptions = {},
        abortSignal: AbortSignal | null = null
    ): YTDlpReadable {
        const readStream: YTDlpReadable = new Readable({ read(size) {} });
        options = YTDlpWrap.setDefaultOptions(options);
        ytDlpArguments = ytDlpArguments.concat(['-o', '-']);
        const ytDlpProcess = spawn(this.binaryPath, ytDlpArguments, options);
        readStream.ytDlpProcess = ytDlpProcess;
        YTDlpWrap.bindAbortSignal(abortSignal, ytDlpProcess);

        let stderrData = '';
        let processError: Error;
        ytDlpProcess.stdout.on('data', (data) => readStream.push(data));
        ytDlpProcess.stderr.on('data', (data) => {
            let stringData = data.toString();
            YTDlpWrap.emitYoutubeDlEvents(stringData, readStream);
            stderrData += stringData;
        });
        ytDlpProcess.on('error', (error) => (processError = error));

        ytDlpProcess.on('close', (code) => {
            if (code === 0 || ytDlpProcess.killed) readStream.destroy();
            else
                readStream.destroy(
                    YTDlpWrap.createError(code, processError, stderrData)
                );
        });
        return readStream;
    }

    async getExtractors(): Promise<string[]> {
        let ytDlpStdout = await this.execPromise(['--list-extractors']);
        return ytDlpStdout.split('\n');
    }

    async getExtractorDescriptions(): Promise<string[]> {
        let ytDlpStdout = await this.execPromise(['--extractor-descriptions']);
        return ytDlpStdout.split('\n');
    }

    async getHelp(): Promise<string> {
        let ytDlpStdout = await this.execPromise(['--help']);
        return ytDlpStdout;
    }

    async getUserAgent(): Promise<string> {
        let ytDlpStdout = await this.execPromise(['--dump-user-agent']);
        return ytDlpStdout;
    }

    async getVersion(): Promise<string> {
        let ytDlpStdout = await this.execPromise(['--version']);
        return ytDlpStdout;
    }

    async getVideoInfo(ytDlpArguments: string | string[]): Promise<any> {
        if (typeof ytDlpArguments == 'string')
            ytDlpArguments = [ytDlpArguments];
        if (
            !ytDlpArguments.includes('-f') &&
            !ytDlpArguments.includes('--format')
        )
            ytDlpArguments = ytDlpArguments.concat(['-f', 'best']);

        let ytDlpStdout = await this.execPromise(
            ytDlpArguments.concat(['--dump-json'])
        );
        try {
            return JSON.parse(ytDlpStdout);
        } catch (e) {
            return JSON.parse(
                '[' + ytDlpStdout.replace(/\n/g, ',').slice(0, -1) + ']'
            );
        }
    }

    static bindAbortSignal(
        signal: AbortSignal | null,
        process: ChildProcess
    ): void {
        signal?.addEventListener('abort', () => {
            process.kill();
        });
    }

    static setDefaultOptions(options: YTDlpOptions): YTDlpOptions {
        if (!options.maxBuffer) options.maxBuffer = 1024 * 1024 * 1024;
        return options;
    }

    static createError(
        code: number | ExecFileException | null,
        processError: Error | null,
        stderrData: string
    ): Error {
        let errorMessage = '\nError code: ' + code;
        if (processError) errorMessage += '\n\nProcess error:\n' + processError;
        if (stderrData) errorMessage += '\n\nStderr:\n' + stderrData;
        return new Error(errorMessage);
    }

    static emitYoutubeDlEvents(
        stringData: string,
        emitter: YTDlpEventEmitter
    ): void {
        let outputLines = stringData.split(/\r|\n/g).filter(Boolean);
        for (let outputLine of outputLines) {
            if (outputLine[0] == '[') {
                let progressMatch = outputLine.match(progressRegex);
                if (progressMatch) {
                    let progressObject: Progress = {};
                    progressObject.percent = parseFloat(
                        progressMatch[1].replace('%', '')
                    );
                    progressObject.totalSize = progressMatch[2].replace(
                        '~',
                        ''
                    );
                    progressObject.currentSpeed = progressMatch[4];
                    progressObject.eta = progressMatch[6];
                    emitter.emit('progress', progressObject);
                }

                let eventType = outputLine
                    .split(' ')[0]
                    .replace('[', '')
                    .replace(']', '');
                let eventData = outputLine.substring(
                    outputLine.indexOf(' '),
                    outputLine.length
                );
                emitter.emit('ytDlpEvent', eventType, eventData);
            }
        }
    }
}