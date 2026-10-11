// Every test file reads text through the Node name reader: recorded Windows OCR answers from
// scripts/fixtures/ocr-recorded/ (BRAWL_OCR=record adds missing ones through the helper, BRAWL_OCR=live reads all live).
import { afterAll } from 'vitest';
import { installTextReader, stopLiveReader } from '../lib/textReader';

installTextReader();
afterAll(() => stopLiveReader());
