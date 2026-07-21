// src/encoding/detector.ts
import { spawn, execSync } from "node:child_process";

export interface DetectionResult {
  encoding: string | null;
  confidence: number;
}

let _pythonCmd: string | null = null;

async function findPython(): Promise<string> {
  if (_pythonCmd) return _pythonCmd;
  for (const cmd of ["python3", "python", "py"]) {
    try {
      execSync(cmd + " --version", { stdio: "ignore" });
      _pythonCmd = cmd;
      return cmd;
    } catch {
      continue;
    }
  }
  throw new Error("Python not found");
}

export function resetPythonCache(): void {
  _pythonCmd = null;
}

const PY_SCRIPT = [
  "import chardet, sys, json",
  "try:",
  "    with open(sys.argv[1], 'rb') as f:",
  "        data = f.read(32768)",
  "        if not data:",
  '            print(json.dumps({"encoding": None, "confidence": 0.0}))',
  "        else:",
  "            r = chardet.detect(data)",
  '            print(json.dumps({"encoding": r.get("encoding"), "confidence": r.get("confidence", 0.0)}))',
  "except Exception:",
  '    print(json.dumps({"encoding": None, "confidence": 0.0}))',
].join("\n");

export async function detectEncoding(filePath: string): Promise<DetectionResult> {
  let pythonCmd: string;
  try {
    pythonCmd = await findPython();
  } catch {
    return { encoding: null, confidence: 0 };
  }

  return new Promise((resolve) => {
    const proc = spawn(pythonCmd, ["-c", PY_SCRIPT, filePath]);
    let output = "";
    proc.stdout.on("data", (d: Buffer) => {
      output += d.toString();
    });
    proc.on("close", (code) => {
      if (code !== 0) {
        resolve({ encoding: null, confidence: 0 });
        return;
      }
      try {
        const r = JSON.parse(output.trim());
        resolve({ encoding: r.encoding || null, confidence: r.confidence || 0 });
      } catch {
        resolve({ encoding: null, confidence: 0 });
      }
    });
    proc.on("error", () => resolve({ encoding: null, confidence: 0 }));
  });
}
