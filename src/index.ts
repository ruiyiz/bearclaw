// Entry point. Settings have to reach process.env before any module that reads
// env vars at import time is evaluated, so the app is pulled in dynamically
// after bootstrap rather than through a static import.
import { bootstrap } from './store/bootstrap.js';

bootstrap();
await import('./app.js');
