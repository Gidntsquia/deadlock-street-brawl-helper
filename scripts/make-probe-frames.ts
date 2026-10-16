// Writes the harness's screen-probe frames: public/demo/_loading.png (the loading-screen fixture at the demo size, for
// the loading-name probe in test mode) and public/demo/_black.png (all black, what a capture of exclusive fullscreen
// reads, for the black-capture hint). `_` frames are listed only under BRAWL_E2E.
import sharp from 'sharp';

await sharp('scripts/fixtures/loading/infernus.png')
  .resize(2000, 1125, { fit: 'fill' })
  .png()
  .toFile('public/demo/_loading.png');
await sharp({ create: { width: 2000, height: 1125, channels: 3, background: '#000' } })
  .png()
  .toFile('public/demo/_black.png');
