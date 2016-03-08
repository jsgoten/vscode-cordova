// Copyright (c) Microsoft Corporation. All rights reserved.
// Licensed under the MIT license. See LICENSE file in the project root for details.


import * as child_process from 'child_process';
import * as elementtree from 'elementtree';
import * as fs from 'fs';
import * as http from 'http';
import * as os from 'os';
import * as path from 'path';
import * as Q from 'q';

import {CordovaIosDeviceLauncher} from './cordovaIosDeviceLauncher';
import {cordovaRunCommand, cordovaStartCommand, execCommand, killChildProcess} from './extension';
import {WebKitDebugAdapter} from '../../debugger/webkit/webKitDebugAdapter';
import {CordovaProjectHelper} from '../utils/cordovaProjectHelper';
import {IProjectType, TelemetryHelper} from '../utils/telemetryHelper';
import {settingsHome} from '../utils/settingsHelper'

export class CordovaDebugAdapter extends WebKitDebugAdapter {
    private static CHROME_DATA_DIR = 'chrome_sandbox_dir'; // The directory to use for the sandboxed Chrome instance that gets launched to debug the app

    private outputLogger: (message: string, error?: boolean) => void;
    private adbPortForwardingInfo: { targetDevice: string, port: number };
    private ionicLivereloadProcess: child_process.ChildProcess;

    public constructor(outputLogger: (message: string, error?: boolean) => void) {
        super();
        this.outputLogger = outputLogger;
    }

    public launch(launchArgs: ICordovaLaunchRequestArgs): Promise<void> {
        return new Promise<void>((resolve, reject) => TelemetryHelper.generate('launch', (generator) => {
            launchArgs.port = launchArgs.port || 9222;
            launchArgs.target = launchArgs.target || 'emulator';
            launchArgs.cwd = CordovaProjectHelper.getCordovaProjectRoot(launchArgs.cwd);

            let platform = launchArgs.platform && launchArgs.platform.toLowerCase();

            return TelemetryHelper.determineProjectTypes(launchArgs.cwd)
                .then((projectType) => {
                    generator.add('projectType', projectType, false);
                    this.outputLogger(`Launching for ${platform} (This may take a while)...`);

                    switch (platform) {
                        case 'android':
                            generator.add('platform', platform, false);
                            return this.launchAndroid(launchArgs, projectType);
                        case 'ios':
                            generator.add('platform', platform, false);
                            return this.launchIos(launchArgs, projectType);
                        case 'browser':
                            generator.add('platform', platform, false);
                            return this.launchBrowser(launchArgs, projectType);
                        default:
                            generator.add('unknownPlatform', platform, true);
                            throw new Error(`Unknown Platform: ${platform}`);
                    }
                }).then(() => {
                    // For the browser platform, we call super.launch(), which already attaches. For other platforms, attach here
                    if (platform !== 'browser') {
                        return this.attach(launchArgs);
                    }
                });
        }).done(resolve, reject));
    }

    public attach(attachArgs: ICordovaAttachRequestArgs): Promise<void> {
        return new Promise<void>((resolve, reject) => TelemetryHelper.generate('attach', (generator) => {
            attachArgs.port = attachArgs.port || 9222;
            attachArgs.target = attachArgs.target || 'emulator';
            attachArgs.cwd = CordovaProjectHelper.getCordovaProjectRoot(attachArgs.cwd);
            let platform = attachArgs.platform && attachArgs.platform.toLowerCase();

            return TelemetryHelper.determineProjectTypes(attachArgs.cwd)
                .then((projectType) => generator.add('projectType', projectType, false))
                .then(() => {
                    this.outputLogger(`Attaching to ${platform}`);
                    switch (platform) {
                        case 'android':
                            generator.add('platform', platform, false);
                            return this.attachAndroid(attachArgs);
                        case 'ios':
                            generator.add('platform', platform, false);
                            return this.attachIos(attachArgs);
                        default:
                            generator.add('unknownPlatform', platform, true);
                            throw new Error(`Unknown Platform: ${platform}`);
                    }
                }).then((processedAttachArgs: IAttachRequestArgs & { url?: string }) => {
                    this.outputLogger('Attaching to app.');
                    this.outputLogger('', true); // Send blank message on stderr to include a divider between prelude and app starting
                    return super.attach(processedAttachArgs, processedAttachArgs.url);
                });
        }).done(resolve, reject));
    }

    public disconnect(): Promise<void> {
        return super.disconnect().then(() => {
            const errorLogger = (message) => this.outputLogger(message, true);

            // Stop ADB port forwarding if necessary
            let adbPortPromise: Q.Promise<void>;

            if (this.adbPortForwardingInfo) {
                const adbForwardStopArgs =
                    ['-s', this.adbPortForwardingInfo.targetDevice,
                        'forward',
                        '--remove', `tcp:${this.adbPortForwardingInfo.port}`];
                adbPortPromise = execCommand('adb', adbForwardStopArgs, errorLogger)
                    .then(() => void 0);
            } else {
                adbPortPromise = Q<void>(void 0);
            }

            // Kill the Ionic dev server if necessary
            let killServePromise: Q.Promise<void>;

            if (this.ionicLivereloadProcess) {
                killServePromise = killChildProcess(this.ionicLivereloadProcess, errorLogger).then(() => {
                    this.ionicLivereloadProcess = null;
                });
            } else {
                killServePromise = Q<void>(void 0);
            }

            // Wait on all the cleanups
            return Q.allSettled([adbPortPromise, killServePromise]).then(() => void 0);
        });
    }

    private launchAndroid(launchArgs: ICordovaLaunchRequestArgs, projectType: IProjectType): Q.Promise<void> {
        let workingDirectory = launchArgs.cwd;
        let errorLogger = (message) => this.outputLogger(message, true);

        // Prepare the command line args
        let isDevice = launchArgs.target.toLowerCase() === 'device';
        let args = ['run', 'android', isDevice ? '--device' : '--emulator', '--verbose'];
        if (['device', 'emulator'].indexOf(launchArgs.target.toLowerCase()) === -1) {
            args.push(`--target=${launchArgs.target}`);
        }

        // If we are using Ionic livereload, we let Ionic do the launch
        if (projectType.ionic && !launchArgs.noLivereload) {
            args.push('--livereload');

            return this.startIonicDevServer(launchArgs, args).then(() => void 0);
        }

        // Launch the app manually if not livereloading
        let cordovaResult = cordovaRunCommand(args, errorLogger, workingDirectory).then((output) => {
            let runOutput = output[0];
            let stderr = output[1];
            let errorMatch = /(ERROR.*)/.exec(runOutput);
            if (errorMatch) {
                errorLogger(runOutput);
                errorLogger(stderr);
                throw new Error(`Error running android`);
            }
            this.outputLogger('App successfully launched');
        });

        return cordovaResult;
    }

    private attachAndroid(attachArgs: ICordovaAttachRequestArgs): Q.Promise<IAttachRequestArgs> {
        let errorLogger = (message) => this.outputLogger(message, true);
        // Determine which device/emulator we are targeting

        let adbDevicesResult = execCommand('adb', ['devices'], errorLogger)
            .then((devicesOutput) => {
                if (attachArgs.target.toLowerCase() === 'device') {
                    let deviceMatch = /\n([^\t]+)\tdevice($|\n)/m.exec(devicesOutput.replace(/\r/g, ''));
                    if (!deviceMatch) {
                        errorLogger(devicesOutput);
                        throw new Error('Unable to find device');
                    }
                    return deviceMatch[1];
                } else {
                    let emulatorMatch = /\n(emulator[^\t]+)\tdevice($|\n)/m.exec(devicesOutput.replace(/\r/g, ''));
                    if (!emulatorMatch) {
                        errorLogger(devicesOutput);
                        throw new Error('Unable to find emulator');
                    }
                    return emulatorMatch[1];
                }
            }, (err: Error): any => {
                let errorCode: string = (<any>err).code;
                if (errorCode && errorCode === 'ENOENT') {
                    throw new Error('Unable to find adb. Please ensure it is in your PATH and re-open Visual Studio Code');
                }
                throw err;
            });
        let packagePromise = Q.nfcall(fs.readFile, path.join(attachArgs.cwd, 'platforms', 'android', 'AndroidManifest.xml'))
            .then((manifestContents) => {
                let parsedFile = elementtree.XML(manifestContents.toString());
                let packageKey = 'package';
                return parsedFile.attrib[packageKey];
            });
        return Q.all([packagePromise, adbDevicesResult]).spread((appPackageName, targetDevice) => {
            let getPidCommandArguments = ['-s', targetDevice, 'shell', `ps | grep ${appPackageName}`];

            let findPidFunction = () => execCommand('adb', getPidCommandArguments, errorLogger).then((pidLine: string) => /^[^ ]+ +([^ ]+) /m.exec(pidLine));

            return CordovaDebugAdapter.retryAsync(findPidFunction, (match) => !!match, 5, 1, 5000, 'Unable to find pid of cordova app').then((match: RegExpExecArray) => match[1])
                .then((pid) => {
                    // Configure port forwarding to the app
                    let forwardSocketCommandArguments = ['-s', targetDevice, 'forward', `tcp:${attachArgs.port}`, `localabstract:webview_devtools_remote_${pid}`];
                    this.outputLogger('Forwarding debug port');
                    return execCommand('adb', forwardSocketCommandArguments, errorLogger).then(() => {
                        this.adbPortForwardingInfo = { targetDevice, port: attachArgs.port };
                    });
                });
        }).then(() => {
            let args: IAttachRequestArgs = { port: attachArgs.port, webRoot: attachArgs.cwd, cwd: attachArgs.cwd };
            return args;
        });
    }

    private launchIos(launchArgs: ICordovaLaunchRequestArgs, projectType: IProjectType): Q.Promise<void> {
        if (os.platform() !== 'darwin') {
            return Q.reject<void>('Unable to launch iOS on non-mac machines');
        }
        let workingDirectory = launchArgs.cwd;
        let errorLogger = (message) => this.outputLogger(message, true);
        this.outputLogger('Launching app (This may take a while)...');

        let iosDebugProxyPort = launchArgs.iosDebugProxyPort || 9221;
        let appStepLaunchTimeout = launchArgs.appStepLaunchTimeout || 5000;
        // Launch the app
        if (launchArgs.target.toLowerCase() === 'device') {
            // cordova run ios does not terminate, so we do not know when to try and attach.
            // Instead, we try to launch manually using homebrew.
            return cordovaRunCommand(['build', 'ios', '--device'], errorLogger, workingDirectory).then(() => {
                let buildFolder = path.join(workingDirectory, 'platforms', 'ios', 'build', 'device');

                this.outputLogger('Installing app on device');

                let installPromise = Q.nfcall(fs.readdir, buildFolder).then((files: string[]) => {
                    let ipaFiles = files.filter((file) => /\.ipa$/.test(file));
                    if (ipaFiles.length === 0) {
                        throw new Error('Unable to find an ipa to install');
                    }
                    let ipaFile = path.join(buildFolder, ipaFiles[0]);

                    return execCommand('ideviceinstaller', ['-i', ipaFile], errorLogger).catch((err: Error): any => {
                        let errorCode: string = (<any>err).code;
                        if (errorCode && errorCode === 'ENOENT') {
                            throw new Error('Unable to find ideviceinstaller. Please ensure it is in your PATH and re-open Visual Studio Code');
                        }
                        throw err;
                    });
                });

                return Q.all([CordovaIosDeviceLauncher.getBundleIdentifier(workingDirectory), installPromise]);
            }).spread((appBundleId) => {
                // App is now built and installed. Try to launch
                this.outputLogger('Launching app');
                return CordovaIosDeviceLauncher.startDebugProxy(iosDebugProxyPort).then(() => {
                    return CordovaIosDeviceLauncher.startApp(appBundleId, iosDebugProxyPort, appStepLaunchTimeout);
                });
            }).then(() => void (0));
        } else {
            let target = launchArgs.target.toLowerCase() === 'emulator' ? null : launchArgs.target;
            if (target) {
                return cordovaRunCommand(['emulate', 'ios', '--target=' + target], errorLogger, workingDirectory).catch((err) => {
                    return cordovaRunCommand(['emulate', 'ios', '--list'], errorLogger, workingDirectory).then((output) => {
                        // List out available targets
                        errorLogger('Unable to run with given target.');
                        errorLogger(output[0].replace(/\*+[^*]+\*+/g, '')); // Print out list of targets, without ** RUN SUCCEEDED **
                        throw err;
                    });
                }).then(() => void (0));
            } else {
                return cordovaRunCommand(['emulate', 'ios'], errorLogger, workingDirectory).then(() => void (0));
            }
        }
    }

    private attachIos(attachArgs: ICordovaAttachRequestArgs): Q.Promise<IAttachRequestArgs> {
        attachArgs.webkitRangeMin = attachArgs.webkitRangeMin || 9223;
        attachArgs.webkitRangeMax = attachArgs.webkitRangeMax || 9322;
        attachArgs.attachAttempts = attachArgs.attachAttempts || 5;
        attachArgs.attachDelay = attachArgs.attachDelay || 1000;
        // Start the tunnel through to the webkit debugger on the device
        this.outputLogger('Configuring debugging proxy');
        return CordovaIosDeviceLauncher.startWebkitDebugProxy(attachArgs.port, attachArgs.webkitRangeMin, attachArgs.webkitRangeMax).then(() => {
            if (attachArgs.target.toLowerCase() === 'device') {
                return CordovaIosDeviceLauncher.getBundleIdentifier(attachArgs.cwd)
                    .then(CordovaIosDeviceLauncher.getPathOnDevice)
                    .then(path.basename);
            } else {
                return Q.nfcall(fs.readdir, path.join(attachArgs.cwd, 'platforms', 'ios', 'build', 'emulator')).then((entries: string[]) => {
                    let filtered = entries.filter((entry) => /\.app$/.test(entry));
                    if (filtered.length > 0) {
                        return filtered[0];
                    } else {
                        throw new Error('Unable to find .app file');
                    }
                });
            }
        }).then((packagePath) => {
            return this.promiseGet(`http://localhost:${attachArgs.port}/json`, 'Unable to communicate with ios_webkit_debug_proxy').then((response: string) => {
                try {
                    let endpointsList = JSON.parse(response);
                    let devices = endpointsList.filter((entry) =>
                        attachArgs.target.toLowerCase() === 'device' ? entry.deviceId !== 'SIMULATOR'
                            : entry.deviceId === 'SIMULATOR'
                    );
                    let device = devices[0];
                    // device.url is of the form 'localhost:port'
                    return parseInt(device.url.split(':')[1], 10);
                } catch (e) {
                    throw new Error('Unable to find iOS target device/simulator. Try specifying a different "port" parameter in launch.json');
                }
            }).then((targetPort) => {
                let findWebviewFunc = () => {
                    return this.promiseGet(`http://localhost:${targetPort}/json`, 'Unable to communicate with target')
                        .then((response: string) => {
                            try {
                                let webviewsList = JSON.parse(response);
                                return webviewsList.filter((entry) => entry.url.indexOf(encodeURIComponent(packagePath)) !== -1);
                            } catch (e) {
                                throw new Error('Unable to find target app');
                            }
                        });
                };

                return CordovaDebugAdapter.retryAsync(findWebviewFunc, (webviewList) => webviewList.length > 0, attachArgs.attachAttempts, 1, attachArgs.attachDelay, 'Unable to find webview')
                    .then((relevantViews) => {
                        return { port: targetPort, url: relevantViews[0].url };
                    });
            });
        }).then(({port, url}) => {
            return { port: port, webRoot: attachArgs.cwd, cwd: attachArgs.cwd, url: url };
        });
    }

    private launchBrowser(launchArgs: ICordovaLaunchRequestArgs, projectType: IProjectType): Q.Promise<void> {
        let workingDirectory = launchArgs.cwd;
        let errorLogger = (message) => this.outputLogger(message, true);

        // Currently, browser is only supported for Ionic projects
        if (!projectType.ionic) {
            let errorMessage = 'Browser is currently only supported for Ionic projects';

            errorLogger(errorMessage);

            return Q.reject<void>(new Error(errorMessage));
        }

        // Set up "ionic serve" args
        let ionicServeArgs: string[] = [
            "serve",
            '--nobrowser'
        ];

        if (launchArgs.noLivereload) {
            ionicServeArgs.push('--nolivereload');
        }

        // Deploy app to browser
        return Q(void 0).then(() => {
            return this.startIonicDevServer(launchArgs, ionicServeArgs);
        }).then((devServerUrl: string) => {
            // Prepare Chrome launch args
            launchArgs.url = devServerUrl;
            launchArgs.userDataDir = path.join(settingsHome(), CordovaDebugAdapter.CHROME_DATA_DIR);

            // Launch Chrome and attach
            this.outputLogger('Attaching to app');

            return super.launch(launchArgs);
        }).catch((err) => {
            errorLogger(err.message);

            // Kill the Ionic dev server if necessary
            let killPromise: Q.Promise<void>;

            if (this.ionicLivereloadProcess) {
                killPromise = killChildProcess(this.ionicLivereloadProcess, errorLogger);
            } else {
                killPromise = Q<void>(void 0);
            }

            // Propagate the error
            return killPromise.finally(() => {
                this.ionicLivereloadProcess = null;
                Q.reject<void>(err)
            });
        });
    }

    /**
     * Starts an Ionic livereload server ("serve or "run / emulate --livereload"). Returns a promise fulfulled with the full URL to the server.
     */
    private startIonicDevServer(launchArgs: ICordovaLaunchRequestArgs, cliArgs: string[]): Q.Promise<string> {
        if (launchArgs.devServerAddress) {
            cliArgs.concat(['--address', launchArgs.devServerAddress]);
        }

        if (launchArgs.devServerPort) {
            cliArgs.concat(['--port', launchArgs.devServerPort.toString()]);
        }

        let isServe: boolean = cliArgs[0] === 'serve';
        let serverReady: boolean = false;
        let serverReadyTimeout: number = 10000;
        let appReadyTimeout: number = 120000; // If we're not serving, the app needs to build and deploy (and potentially start the emulator), which can be very long
        let isLivereloading: boolean = isServe && cliArgs.indexOf('--nolivereload') === -1 || cliArgs.indexOf('--livereload') !== -1;
        let serverDeferred = Q.defer<void>();
        let appDeferred = Q.defer<void>();
        let serverOutput: string = '';

        this.ionicLivereloadProcess = cordovaStartCommand(cliArgs, launchArgs.cwd);
        this.ionicLivereloadProcess.on('error', (err) => {
            if (err.code === 'ENOENT') {
                serverDeferred.reject(new Error('Ionic not found, please run \'npm install –g ionic\' to install it globally'));
            } else {
                serverDeferred.reject(err);
            }
        });

        let serverOutputHandler = (data: Buffer) => {
            serverOutput += data.toString();

            // Listen for the server to be ready. We check for the "Ionic server commands" string to decide that.
            //
            // Exemple output of Ionic dev server:
            //
            // Running live reload server: undefined
            // Watching: 0=www/**/*, 1=!www/lib/**/*
            // Running dev server:  http://localhost:8100
            // Ionic server commands, enter:
            // restart or r to restart the client app from the root
            // goto or g and a url to have the app navigate to the given url
            // consolelogs or c to enable/disable console log output
            // serverlogs or s to enable/disable server log output
            // quit or q to shutdown the server and exit
            //
            // ionic $
            if (!serverReady && /Ionic server commands/.test(serverOutput)) {
                serverReady = true;
                serverDeferred.resolve(void 0);
            }

            if (serverReady) {
                // Now that the server is ready, listen for the app to be ready as well. For "serve", this is always true, because no build and deploy is involved. For "run" and "emulate", we need to
                // wait until we encounter the "Ionic server commands" string a second time. The reason for that is that the output of the server will be the same as above, plus the build output, and
                // finally the "Ionic server commands" part will be printed again at the very end.
                if (isServe || /Ionic server commands(?:.*\r?\n)*.*Ionic server commands/.test(serverOutput)) {
                    this.ionicLivereloadProcess.stdout.removeListener('data', serverOutputHandler);
                    appDeferred.resolve(void 0);
                }
            }

            if (/Address Selection:/.test(serverOutput)) {
                // Ionic does not know which address to use for the dev server, and requires human interaction; error out and let the user know
                let errorMessage: string = 'Multiple addresses available for the Ionic dev server, please specify the \'devServerAddress\' property in the launch config.';
                let addresses: string[] = /(\d+\) .*)/gm.exec(serverOutput);

                if (addresses) {
                    // Give the user the list of addresses that Ionic found
                    addresses.shift();
                    errorMessage += [' Available addresses:'].concat(addresses).join(os.EOL + ' ');
                }

                serverDeferred.reject(new Error(errorMessage));
            }
        };

        this.ionicLivereloadProcess.stdout.on('data', serverOutputHandler);
        this.outputLogger(`Starting Ionic dev server (live reload: ${isLivereloading})`);

        return serverDeferred.promise.timeout(serverReadyTimeout, `Starting the Ionic dev server timed out (${serverReadyTimeout} ms)`).then(() => {
            this.outputLogger('Building and deploying app');

            return appDeferred.promise.timeout(appReadyTimeout, `Building and deploying the app timed out (${appReadyTimeout} ms)`);
        }).then(() => {
            // Find the dev server full URL
            let match: string[] = /Running dev server:.*(http:\/\/.*)/gm.exec(serverOutput);

            if (!match || match.length < 2) {
                return Q.reject<string>(new Error('Unable to determine the Ionic dev server address, please try re-launching the debugger'));
            }

            // The dev server address is the captured group at index 1 of the match
            return Q(match[1]);
        });
    }

    private static retryAsync<T>(func: () => Q.Promise<T>, condition: (result: T) => boolean, maxRetries: number, iteration: number, delay: number, failure: string): Q.Promise<T> {
        return func().then(result => {
            if (condition(result)) {
                return result;
            }

            if (iteration < maxRetries) {
                return Q.delay(delay).then(() => CordovaDebugAdapter.retryAsync(func, condition, maxRetries, iteration + 1, delay, failure));
            }

            throw new Error(failure);
        });
    }

    private promiseGet(url: string, reqErrMessage: string): Q.Promise<string> {
        let deferred = Q.defer<string>();
        let req = http.get(url, function(res) {
            let responseString = '';
            res.on('data', (data: Buffer) => {
                responseString += data.toString();
            });
            res.on('end', () => {
                deferred.resolve(responseString);
            });
        });
        req.on('error', (err: Error) => {
            this.outputLogger(reqErrMessage);
            deferred.reject(err);
        });
        return deferred.promise;
    }
}
