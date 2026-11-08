import fs from 'node:fs'
import path from 'node:path'
import sharp from 'sharp'

const input = path.resolve('web/public/icons/icon.svg')
const out = path.dirname(input)
const svg = fs.readFileSync(input)

for (const size of [192, 512]) {
  await sharp(svg).resize(size, size).png().toFile(path.join(out, `icon-${size}.png`))
}
await sharp(svg).resize(512, 512).png().toFile(path.join(out, 'icon-maskable-512.png'))
await sharp(svg).resize(180, 180).png().toFile(path.join(out, 'apple-touch-icon.png'))
console.log('icons generated')
