// Kept so `tsx src/scripts/whatsapp-auth.ts` still works. The real entry point
// is `bearclaw whatsapp-auth`; this file goes away with the rest of src/scripts.
import { runWhatsappAuth } from '../cli/whatsapp-auth.js';

export { runWhatsappAuth };

runWhatsappAuth().catch((err) => {
  console.error('Authentication failed:', err.message);
  process.exit(1);
});
