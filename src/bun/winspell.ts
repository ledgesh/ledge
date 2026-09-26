// Windows' spell checker, for the editor's right-click menu on Windows
// (bun/spelling.ts). It is ISpellChecker, the COM interface WebView2 draws its
// squiggles from, called through bun:ffi: a COM object is a pointer to a table
// of function pointers, and CFunction calls an entry by its index. A lookup
// takes a few milliseconds, with no process to start.
import { CFunction, dlopen, FFIType, ptr, read, type Pointer } from "bun:ffi";

const CLSID_SPELL_CHECKER_FACTORY = "7AB36653-1796-484B-BDFA-E74F1DB7C1DC";
const IID_ISPELL_CHECKER_FACTORY = "8E018A9D-2415-4677-BF08-794EA61F94BB";
const CLSCTX_INPROC_SERVER = 1;
const COINIT_APARTMENTTHREADED = 2;
const S_OK = 0;

// The vtable slots used here. Every interface starts with IUnknown's three.
const RELEASE = 2;
const FACTORY_IS_SUPPORTED = 4;
const FACTORY_CREATE = 5;
const CHECKER_CHECK = 4;
const CHECKER_SUGGEST = 5;
const CHECKER_ADD = 6;
const ENUM_NEXT = 3;

/** A GUID's 16 bytes, from its registry spelling. */
export function guidBytes(text: string): Buffer {
  const hex = text.replaceAll("-", "");
  const bytes = Buffer.alloc(16);
  bytes.writeUInt32LE(parseInt(hex.slice(0, 8), 16), 0);
  bytes.writeUInt16LE(parseInt(hex.slice(8, 12), 16), 4);
  bytes.writeUInt16LE(parseInt(hex.slice(12, 16), 16), 6);
  for (let i = 0; i < 8; i++) bytes[8 + i] = parseInt(hex.slice(16 + 2 * i, 18 + 2 * i), 16);
  return bytes;
}

function wide(text: string): Buffer {
  return Buffer.from(`${text}\0`, "utf16le");
}

// CFunction compiles a wrapper for each function pointer, so each one is made
// once and kept.
const wrappers = new Map<string, (...values: unknown[]) => unknown>();

/** Calls vtable entry `index` of the COM object at `obj`. */
function call(obj: number, index: number, args: FFIType[], values: unknown[], returns: FFIType = FFIType.i32): number {
  const fn = read.ptr(read.ptr(obj as Pointer, 0) as Pointer, index * 8) as Pointer;
  const key = `${fn}:${args.join(",")}:${returns}`;
  let wrapper = wrappers.get(key);
  if (!wrapper) {
    wrapper = CFunction({ ptr: fn, args: [FFIType.ptr, ...args], returns }) as unknown as (...values: unknown[]) => unknown;
    wrappers.set(key, wrapper);
  }
  return wrapper(obj, ...values) as number;
}

function release(obj: number): void {
  call(obj, RELEASE, [], [], FFIType.u32);
}

/** A NUL-terminated UTF-16 string at `p`. */
function readWide(p: number): string {
  const units: number[] = [];
  for (let unit = read.u16(p as Pointer, 0); unit !== 0; unit = read.u16(p as Pointer, units.length * 2)) units.push(unit);
  return String.fromCharCode(...units);
}

let ole: ReturnType<typeof openOle> | null = null;

// Opened on first use: this module is imported on every platform.
function openOle() {
  return dlopen("ole32.dll", {
    CoInitializeEx: { args: [FFIType.ptr, FFIType.u32], returns: FFIType.i32 },
    CoCreateInstance: { args: [FFIType.ptr, FFIType.ptr, FFIType.u32, FFIType.ptr, FFIType.ptr], returns: FFIType.i32 },
    CoTaskMemFree: { args: [FFIType.ptr], returns: FFIType.void },
  }).symbols;
}

function userLanguage(): string {
  const { symbols } = dlopen("kernel32.dll", { GetUserDefaultLocaleName: { args: [FFIType.ptr, FFIType.i32], returns: FFIType.i32 } });
  const buf = Buffer.alloc(85 * 2);
  symbols.GetUserDefaultLocaleName(ptr(buf), 85);
  return buf.toString("utf16le").replace(/\0.*$/s, "");
}

// The checker for the user's language, made once. 0 when Windows has no
// dictionary for it, or none at all.
let checker: number | null = null;

function spellChecker(): number {
  if (checker !== null) return checker;
  checker = 0;
  try {
    ole ??= openOle();
    // Single-threaded, as Electrobun's file dialog starts COM on this same
    // thread: a thread set up multithreaded first makes the dialog fail with
    // "Failed to initialize COM".
    ole.CoInitializeEx(null, COINIT_APARTMENTTHREADED);
    const out = new BigUint64Array(1);
    const made = ole.CoCreateInstance(
      ptr(guidBytes(CLSID_SPELL_CHECKER_FACTORY)),
      null,
      CLSCTX_INPROC_SERVER,
      ptr(guidBytes(IID_ISPELL_CHECKER_FACTORY)),
      ptr(out),
    );
    if (made !== S_OK) return checker;
    const factory = Number(out[0]);
    const lang = wide(userLanguage());
    const supported = new Int32Array(1);
    call(factory, FACTORY_IS_SUPPORTED, [FFIType.ptr, FFIType.ptr], [ptr(lang), ptr(supported)]);
    if (supported[0] && call(factory, FACTORY_CREATE, [FFIType.ptr, FFIType.ptr], [ptr(lang), ptr(out)]) === S_OK) {
      checker = Number(out[0]);
    }
    release(factory);
  } catch (err) {
    console.error("[spelling] Windows spell checker unavailable:", err);
  }
  return checker;
}

/** Whether Windows has a dictionary for the user's language. */
export function hasWindowsDictionary(): boolean {
  return spellChecker() !== 0;
}

/** Whether `word` is misspelled, and up to five replacements. Check lists one
 * error for a misspelled word and none for a correct one. */
export function checkWindowsWord(word: string): { misspelled: boolean; guesses: string[] } {
  const sc = spellChecker();
  if (sc === 0 || !ole) return { misspelled: false, guesses: [] };
  const out = new BigUint64Array(1);
  if (call(sc, CHECKER_CHECK, [FFIType.ptr, FFIType.ptr], [ptr(wide(word)), ptr(out)]) !== S_OK) return { misspelled: false, guesses: [] };
  const errors = Number(out[0]);
  const misspelled = call(errors, ENUM_NEXT, [FFIType.ptr], [ptr(out)]) === S_OK;
  if (misspelled) release(Number(out[0]));
  release(errors);
  if (!misspelled) return { misspelled: false, guesses: [] };
  const guesses: string[] = [];
  if (call(sc, CHECKER_SUGGEST, [FFIType.ptr, FFIType.ptr], [ptr(wide(word)), ptr(out)]) === S_OK) {
    const suggestions = Number(out[0]);
    const fetched = new Uint32Array(1);
    while (guesses.length < 5 && call(suggestions, ENUM_NEXT, [FFIType.u32, FFIType.ptr, FFIType.ptr], [1, ptr(out), ptr(fetched)]) === S_OK && fetched[0] === 1) {
      const text = Number(out[0]);
      guesses.push(readWide(text));
      ole.CoTaskMemFree(text as Pointer);
    }
    release(suggestions);
  }
  return { misspelled: true, guesses };
}

/** Adds `word` to the user's dictionary, which WebView2 and every other
 * Windows app share. */
export function learnWindowsWord(word: string): boolean {
  const sc = spellChecker();
  return sc !== 0 && call(sc, CHECKER_ADD, [FFIType.ptr], [ptr(wide(word))]) === S_OK;
}
