/**
 * Angular test bootstrap for Vitest.
 *
 * `@angular/compiler` must be imported for its side effects BEFORE the testing environment is
 * initialised: TestBed compiles components at runtime, and without the JIT compiler registered the
 * first injection fails with "needs to be compiled using the JIT compiler, but '@angular/compiler'
 * is not available". Importing it here rather than per-spec means a new spec cannot forget it.
 */
import '@angular/compiler';
import { getTestBed } from '@angular/core/testing';
import {
  BrowserTestingModule,
  platformBrowserTesting,
} from '@angular/platform-browser/testing';

getTestBed().initTestEnvironment(BrowserTestingModule, platformBrowserTesting());
