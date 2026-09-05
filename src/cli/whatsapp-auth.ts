/**
 * WhatsApp authentication. Displays a QR code, waits for the scan, saves the
 * credentials, then exits.
 *
 * Usage: bearclaw whatsapp-auth
 */
import fs from 'node:fs';
import path from 'node:path';
import pino from 'pino';
import qrcode from 'qrcode-terminal';

import makeWASocket, {
  DisconnectReason,
  makeCacheableSignalKeyStore,
  useMultiFileAuthState,
} from '@whiskeysockets/baileys';

import { AUTH_DIR as VAR_AUTH_DIR } from '../store/paths.js';

const AUTH_DIR = path.join(VAR_AUTH_DIR, 'whatsapp');

const logger = pino({
  level: 'warn', // Quiet logging - only show errors
});

export async function runWhatsappAuth(): Promise<void> {
  fs.mkdirSync(AUTH_DIR, { recursive: true });

  const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);

  if (state.creds.registered) {
    console.log('✓ Already authenticated with WhatsApp');
    console.log(`  To re-authenticate, delete ${AUTH_DIR} and run again.`);
    process.exit(0);
  }

  console.log('Starting WhatsApp authentication...\n');

  const sock = makeWASocket({
    auth: {
      creds: state.creds,
      keys: makeCacheableSignalKeyStore(state.keys, logger),
    },
    printQRInTerminal: false,
    logger,
    browser: ['BearClaw', 'Chrome', '1.0.0'],
  });

  sock.ev.on('connection.update', (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      console.log('Scan this QR code with WhatsApp:\n');
      console.log('  1. Open WhatsApp on your phone');
      console.log('  2. Tap Settings → Linked Devices → Link a Device');
      console.log('  3. Point your camera at the QR code below\n');
      qrcode.generate(qr, { small: true });
    }

    if (connection === 'close') {
      const reason = (lastDisconnect?.error as any)?.output?.statusCode;

      if (reason === DisconnectReason.loggedOut) {
        console.log(`\n✗ Logged out. Delete ${AUTH_DIR} and try again.`);
        process.exit(1);
      } else {
        // Transient error (e.g. 515 stream error) — retry after brief delay
        console.log('\n⟳ Connection interrupted, retrying in 2s...\n');
        setTimeout(() => {
          runWhatsappAuth().catch((err) => {
            console.error('Authentication failed:', err.message);
            process.exit(1);
          });
        }, 2000);
      }
    }

    if (connection === 'open') {
      console.log('\n✓ Successfully authenticated with WhatsApp!');
      console.log(`  Credentials saved to ${AUTH_DIR}/`);
      console.log('  You can now start the BearClaw service.\n');

      // Give it a moment to save credentials, then exit
      setTimeout(() => process.exit(0), 1000);
    }
  });

  sock.ev.on('creds.update', saveCreds);
}
