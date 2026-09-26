#!/usr/bin/env bun
// Electrobun's postBuild hook on Windows: signs the app before it is packed
// into the update tarball and the installer (scripts/sign-windows.ts).
import { signApp } from "./sign-windows";

signApp();
