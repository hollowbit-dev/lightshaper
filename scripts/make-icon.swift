// Draws Lightshaper's app icon (1024x1024 PNG): violet tile with a disc split into light and shadow.
import AppKit
let size: CGFloat = 1024
let img = NSImage(size: NSSize(width: size, height: size))
img.lockFocus()
let ctx = NSGraphicsContext.current!.cgContext
let inset: CGFloat = 100
let rect = CGRect(x: inset, y: inset, width: size - inset * 2, height: size - inset * 2)
let tile = CGPath(roundedRect: rect, cornerWidth: 190, cornerHeight: 190, transform: nil)
ctx.saveGState()
ctx.setShadow(offset: CGSize(width: 0, height: -14), blur: 40, color: NSColor(white: 0, alpha: 0.35).cgColor)
ctx.addPath(tile); ctx.setFillColor(NSColor.black.cgColor); ctx.fillPath()
ctx.restoreGState()
ctx.saveGState()
ctx.addPath(tile); ctx.clip()
let cs = CGColorSpaceCreateDeviceRGB()
let g = CGGradient(colorsSpace: cs, colors: [
  NSColor(red: 0.82, green: 0.77, blue: 1.0, alpha: 1).cgColor,
  NSColor(red: 0.62, green: 0.51, blue: 1.0, alpha: 1).cgColor,
  NSColor(red: 0.33, green: 0.22, blue: 0.86, alpha: 1).cgColor] as CFArray, locations: [0, 0.5, 1])!
ctx.drawLinearGradient(g, start: CGPoint(x: inset, y: size - inset), end: CGPoint(x: size - inset, y: inset), options: [])
let glow = CGGradient(colorsSpace: cs, colors: [NSColor(white: 1, alpha: 0.30).cgColor, NSColor(white: 1, alpha: 0).cgColor] as CFArray, locations: [0, 1])!
ctx.drawRadialGradient(glow, startCenter: CGPoint(x: size * 0.38, y: size * 0.66), startRadius: 0, endCenter: CGPoint(x: size * 0.38, y: size * 0.66), endRadius: 460, options: [])
ctx.restoreGState()
// The disc: lit half white, shaded half deep violet, split on the diagonal.
let c = CGPoint(x: 512, y: 512), r: CGFloat = 245
let disc = CGRect(x: c.x - r, y: c.y - r, width: 2 * r, height: 2 * r)
ctx.saveGState()
ctx.setShadow(offset: CGSize(width: 0, height: -16), blur: 40, color: NSColor(red: 0.12, green: 0.05, blue: 0.35, alpha: 0.5).cgColor)
ctx.setFillColor(NSColor.white.cgColor); ctx.fillEllipse(in: disc)
ctx.restoreGState()
ctx.saveGState()
ctx.addEllipse(in: disc); ctx.clip()
ctx.move(to: CGPoint(x: c.x - 400, y: c.y - 400)); ctx.addLine(to: CGPoint(x: c.x + 400, y: c.y + 400)); ctx.addLine(to: CGPoint(x: c.x + 400, y: c.y - 400)); ctx.closePath()
ctx.clip()
let shade = CGGradient(colorsSpace: cs, colors: [NSColor(red: 0.30, green: 0.20, blue: 0.70, alpha: 1).cgColor, NSColor(red: 0.10, green: 0.05, blue: 0.24, alpha: 1).cgColor] as CFArray, locations: [0, 1])!
ctx.drawLinearGradient(shade, start: CGPoint(x: c.x, y: c.y), end: CGPoint(x: c.x + r * 0.7, y: c.y - r * 0.7), options: [.drawsAfterEndLocation])
ctx.restoreGState()
img.unlockFocus()
let rep = NSBitmapImageRep(data: img.tiffRepresentation!)!
try! rep.representation(using: .png, properties: [:])!.write(to: URL(fileURLWithPath: CommandLine.arguments[1]))
