import { h, render, Component } from "preact";

import XTerm, { Command, WASICommand, CommandOptions, Terminal } from "./term";
import * as fit from "xterm/lib/addons/fit/fit";
Terminal.applyAddon(fit);

import "./index.css";
import stdinWasmUrl from "./assets/stdin.wasm";

let compiledModules: { [key: string]: WebAssembly.Module } = {};

let commands = {
  cowsay: "https://registry-cdn.wapm.dev/contents/_/cowsay/0.1.2/cowsay.wasm",
  a: stdinWasmUrl,
  matrix:
    "https://registry-cdn.wapm.dev/contents/syrusakbary/wasm-matrix/0.0.4/optimized.wasm",
  lolcat: "https://registry-cdn.wapm.dev/contents/_/lolcat/0.1.1/lolcat.wasm"
};

const compileFromUrl = async (url: string): Promise<WebAssembly.Module> => {
  // @ts-ignore
  if (WebAssembly.compileStreaming && false) {
    // @ts-ignore
    return await WebAssembly.compileStreaming(fetch(url));
  } else {
    let fetched = await fetch(url);
    let buffer = await fetched.arrayBuffer();
    return await WebAssembly.compile(buffer);
  }
};

const getCommand = async (options: CommandOptions): Promise<WASICommand> => {
  let [commandName, commandArgs] = options.args;
  let commandUrl = commands[commandName];
  if (!commandUrl) {
    throw new Error(`command not found ${commandName}`);
  }

  let cachedData = compiledModules[commandUrl];
  if (!cachedData) {
    cachedData = compiledModules[commandUrl] = await compileFromUrl(commandUrl);
  }
  return new WASICommand({
    args: options.args,
    env: options.env,
    module: cachedData
  });
};

class App extends Component {
  render() {
    return (
      <div>
        <XTerm
          getCommand={getCommand}
          onSetup={component => {
            (component.xterm as any).fit();
          }}
        />
      </div>
    );
  }
}

render(<App />, document.getElementById("root"));
