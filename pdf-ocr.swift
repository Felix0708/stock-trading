import AppKit
import Foundation
import PDFKit
import Vision

guard CommandLine.arguments.count >= 2 else {
    fputs("usage: pdf-ocr FILE [MAX_PAGES]\n", stderr)
    exit(2)
}

let file = CommandLine.arguments[1]
let maxPages = CommandLine.arguments.count > 2 ? Int(CommandLine.arguments[2]) ?? 5 : 5
guard let document = PDFDocument(url: URL(fileURLWithPath: file)) else {
    fputs("PDF open failed\n", stderr)
    exit(1)
}

for index in 0..<min(document.pageCount, maxPages) {
    guard let page = document.page(at: index) else { continue }
    let bounds = page.bounds(for: .mediaBox)
    let scale = min(2.0, 2200.0 / max(bounds.width, bounds.height))
    let size = NSSize(width: bounds.width * scale, height: bounds.height * scale)
    let image = page.thumbnail(of: size, for: .mediaBox)
    var proposed = NSRect(origin: .zero, size: size)
    guard let cgImage = image.cgImage(forProposedRect: &proposed, context: nil, hints: nil) else { continue }

    let request = VNRecognizeTextRequest()
    request.recognitionLevel = .accurate
    request.recognitionLanguages = ["ko-KR", "en-US"]
    request.usesLanguageCorrection = true
    do {
        try VNImageRequestHandler(cgImage: cgImage).perform([request])
    } catch {
        fputs("OCR page \(index + 1) failed: \(error)\n", stderr)
        continue
    }

    let observations = (request.results ?? []).sorted {
        if abs($0.boundingBox.midY - $1.boundingBox.midY) > 0.015 {
            return $0.boundingBox.midY > $1.boundingBox.midY
        }
        return $0.boundingBox.minX < $1.boundingBox.minX
    }
    print("\n--- page \(index + 1) ---")
    for observation in observations {
        if let text = observation.topCandidates(1).first?.string { print(text) }
    }
}
