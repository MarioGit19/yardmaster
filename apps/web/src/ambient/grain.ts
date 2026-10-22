// Film grain, DESIGN.md §4.1: generated once per page from canvas noise, so no binary asset ships.

const SIZE = 128;
let url: Promise<string | null> | null = null;

/** An object URL of a tileable grey-noise PNG, or null where canvas is unavailable. */
export function grainUrl(random: () => number = Math.random): Promise<string | null> {
  url ??= new Promise((resolve) => {
    try {
      const canvas = document.createElement('canvas');
      canvas.width = SIZE;
      canvas.height = SIZE;
      const ctx = canvas.getContext('2d');
      if (!ctx || typeof canvas.toBlob !== 'function') return resolve(null);
      const image = ctx.createImageData(SIZE, SIZE);
      for (let i = 0; i < image.data.length; i += 4) {
        const v = Math.floor(random() * 256);
        image.data[i] = v;
        image.data[i + 1] = v;
        image.data[i + 2] = v;
        image.data[i + 3] = 255;
      }
      ctx.putImageData(image, 0, 0);
      canvas.toBlob((blob) => resolve(blob ? URL.createObjectURL(blob) : null), 'image/png');
    } catch {
      resolve(null);
    }
  });
  return url;
}
