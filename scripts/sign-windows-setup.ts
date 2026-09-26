#!/usr/bin/env bun
// Electrobun's postPackage hook on Windows: signs the installer in the setup
// zip (scripts/sign-windows.ts).
import { signSetup } from "./sign-windows";

signSetup();
