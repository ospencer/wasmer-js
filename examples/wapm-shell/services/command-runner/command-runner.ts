import { h, Component } from "preact";

import * as Comlink from "comlink";

import { Duplex, PassThrough } from "stream";
import parse_ from "shell-parse";
const parse = parse_;

import { Terminal } from "xterm";

import Process from "../process/process";

import { CommandOptions, Command } from "./command";

import CommandCache from "./command-cache";

const getCommandOptionsFromAST = (
  ast: any,
  commandCache: CommandCache
): Promise<Array<CommandOptions>> => {
  // The array of command options we are returning
  let commandOptions: Array<CommandOptions> = [];

  let command = ast.command.value;
  let commandArgs = ast.args.map((arg: any) => arg.value);
  let args = [command, ...commandArgs];

  let env = Object.fromEntries(
    Object.entries(ast.env).map(([key, value]: [string, any]) => [
      key,
      value.value
    ])
  );

  // Get other commands from the redirects
  const redirectTask = async () => {
    if (ast.redirects) {
      let astRedirect = ast.redirects[0];
      if (astRedirect && astRedirect.type === "pipe") {
        const redirectedCommandOptions = await getCommandOptionsFromAST(
          astRedirect.command,
          commandCache
        );
        // Add the child options to our command options
        commandOptions = commandOptions.concat(redirectedCommandOptions);
      }
    }
  };

  const getWasmModuleTask = async () => {
    // Get our Wasm Module
    return await commandCache.getWasmModuleForCommandName(command);
  };

  return redirectTask()
    .then(() => getWasmModuleTask())
    .then(wasmModule => {
      commandOptions.unshift({
        args,
        env,
        module: wasmModule
      });
      return commandOptions;
    });
};

export default class CommandRunner {
  commandCache: CommandCache;
  commandOptionsForProcessesToRun: Array<any>;
  spawnedProcessObjects: Array<any>;
  initialStdinDataForNextProcess: Uint8Array;
  isRunning: boolean;

  xterm: Terminal;
  commandString: string;
  commandEndCallback: Function;

  constructor(
    xterm: Terminal,
    commandString: string,
    commandEndCallback: Function
  ) {
    this.commandCache = new CommandCache();
    this.commandOptionsForProcessesToRun = [];
    this.spawnedProcessObjects = [];
    this.initialStdinDataForNextProcess = new Uint8Array();
    this.isRunning = false;
    this.xterm = xterm;
    this.commandString = commandString;
    this.commandEndCallback = commandEndCallback;
  }

  async runCommand() {
    // First, let's parse the string into a bash AST
    const commandAst = parse(this.commandString);
    try {
      if (commandAst.length > 1) {
        throw new Error("Only one command permitted");
      }
      if (commandAst[0].type !== "command") {
        throw new Error("Only commands allowed");
      }

      // Translate our AST into Command Options
      this.commandOptionsForProcessesToRun = await getCommandOptionsFromAST(
        commandAst[0],
        this.commandCache
      );
    } catch (c) {
      this.xterm.write(`wapm shell: parse error (${c.toString()})\r\n`);
      this.commandEndCallback();
      return;
    }

    this.isRunning = true;

    // Spawn the first process
    await this.tryToSpawnProcess(0);
  }

  async tryToSpawnProcess(commandOptionIndex: number) {
    if (
      this.spawnedProcessObjects.length < 2 &&
      commandOptionIndex < this.commandOptionsForProcessesToRun.length
    ) {
      await this.spawnProcess(commandOptionIndex);
    }
  }

  async spawnProcess(commandOptionIndex: number) {
    let spawnedProcessObject = undefined;
    // TODO: remove && false once the fallback works
    if ((window as any).SharedArrayBuffer && (window as any).Atomics && false) {
      spawnedProcessObject = await this.spawnProcessAsWorker(
        commandOptionIndex
      );
    } else {
      spawnedProcessObject = await this.spawnProcessAsService(
        commandOptionIndex
      );
    }

    // Remove the initial stdin if we added it
    if (this.initialStdinDataForNextProcess.length > 0) {
      this.initialStdinDataForNextProcess = new Uint8Array();
    }

    // Record this process as spawned
    this.spawnedProcessObjects.push(spawnedProcessObject);

    // TODO: Spawn the next process to be ready to receive stdin by streaming
    // Try to spawn the next process, if we haven't already
    // this.tryToSpawnProcess(commandOptionIndex + 1);

    // Start the process
    spawnedProcessObject.process.start();
  }

  async spawnProcessAsWorker(commandOptionIndex: number) {
    // Generate our process
    const processWorker = new Worker("./workers/process.worker.js");
    const processComlink = Comlink.wrap(processWorker);

    // @ts-ignore
    const process: any = await new processComlink(
      this.commandOptionsForProcessesToRun[commandOptionIndex],
      // Data Callback
      Comlink.proxy(this.processDataCallback.bind(this, commandOptionIndex)),
      // End Callback
      Comlink.proxy(
        this.processEndCallback.bind(this, commandOptionIndex, processWorker)
      ),
      // Error Callback
      Comlink.proxy(this.processErrorCallback.bind(this, commandOptionIndex)),
      // Stdin
      this.initialStdinDataForNextProcess.length > 0
        ? this.initialStdinDataForNextProcess
        : undefined
    );

    return {
      process,
      worker: processWorker
    };
  }

  async spawnProcessAsService(commandOptionIndex: number) {
    const process = new Process(
      this.commandOptionsForProcessesToRun[commandOptionIndex],
      // Data Callback
      this.processDataCallback.bind(this, commandOptionIndex),
      // End Callback
      this.processEndCallback.bind(this, commandOptionIndex),
      // Error Callback
      this.processErrorCallback.bind(this, commandOptionIndex),
      // Stdin
      this.initialStdinDataForNextProcess.length > 0
        ? this.initialStdinDataForNextProcess
        : undefined
    );

    return {
      process
    };
  }

  processDataCallback(commandOptionIndex: number, data: Uint8Array) {
    if (commandOptionIndex < this.commandOptionsForProcessesToRun.length - 1) {
      // Pass along to the next spawned process
      if (this.spawnedProcessObjects.length > 1) {
        this.spawnedProcessObjects[1].process.receiveStdinChunk(data);
      } else {
        const newInitialStdinData = new Uint8Array(
          data.length + this.initialStdinDataForNextProcess.length
        );
        newInitialStdinData.set(this.initialStdinDataForNextProcess);
        newInitialStdinData.set(
          data,
          this.initialStdinDataForNextProcess.length
        );
        this.initialStdinDataForNextProcess = newInitialStdinData;
      }
    } else {
      // Write the output to our terminal
      let dataString = new TextDecoder("utf-8").decode(data);
      this.xterm.write(dataString.replace(/\n/g, "\r\n"));
    }
  }

  processEndCallback(commandOptionIndex: number, processWorker?: Worker) {
    if (processWorker) {
      // Terminate our worker
      processWorker.terminate();
    }

    // Remove ourself from the spawned workers
    this.spawnedProcessObjects.shift();

    if (commandOptionIndex < this.commandOptionsForProcessesToRun.length - 1) {
      // Try to spawn the next process, if we haven't already
      this.tryToSpawnProcess(commandOptionIndex + 1);
    } else {
      // We are now done!
      // Call the passed end callback
      this.isRunning = false;
      this.commandEndCallback();
    }
  }

  processErrorCallback(commandOptionIndex: number, error: string) {
    this.xterm.write(
      `Program ${this.commandOptionsForProcessesToRun[commandOptionIndex].args[0]}: ${error}\r\n`
    );
    this.kill();
    this.commandEndCallback();
  }

  kill() {
    if (!this.isRunning) {
      return;
    }

    this.spawnedProcessObjects.forEach(processObject => {
      if (processObject.worker) {
        processObject.worker.terminate();
      }
    });

    this.commandOptionsForProcessesToRun = [];
    this.spawnedProcessObjects = [];
    this.isRunning = false;

    this.commandEndCallback();
  }
}
