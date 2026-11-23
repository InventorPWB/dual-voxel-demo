// Entry point. With "Realistic textures" on (Settings), loads the
// photographic textures first, so the texture arrays and the colours derived
// from textures are built from them; off, the demo keeps its 32×32 pixel-art
// textures. Then starts the demo.
import { loadPhotoTextures } from './render/photoTextures.js';
import { savedSetting } from './ui/settings.js';

if (savedSetting('realisticTextures')) await loadPhotoTextures();
await import('./main.js');
