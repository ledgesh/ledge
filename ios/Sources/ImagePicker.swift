import PhotosUI
import UIKit
import UniformTypeIdentifiers

/// Where Insert Image… gets a picture on a phone: the photo library, the
/// camera, or Files (ios.md §11).
///
/// A menu of the three comes first, the one Safari shows for an image file
/// input. Each source is its own system screen, and only the person holding the
/// phone knows which one the picture is in.
///
/// Bytes only. The file is the server's to name (remote.md §2), so this
/// answers base64 and the page sends it on to `assetWrite`, which reads the
/// magic and writes `.jpg` or `.png` (bun/assets.ts extensionFor).
///
/// JPEG because a camera roll holds photographs: the first one inserted from a
/// phone was 3 MB on the device and 28 MB re-encoded losslessly. A PNG from
/// Files is the exception (`encode(file:)` below).
///
/// Every source is re-encoded rather than forwarded, which drops the picture's
/// own EXIF, so the GPS coordinates a phone stamps on it do not reach the
/// server. The Exif block UIKit writes into its JPEG carries no location.
enum ImagePicker {
    /// 0.9, which is where JPEG stops being distinguishable from the original
    /// by eye and keeps being a tenth of the size. Natives encodes a pasted
    /// picture at the same quality.
    static let quality: CGFloat = 0.9

    /// Offer the sources over `host` and answer base64, or "" for a cancel at
    /// either step, a non-image, or a picture that could not be read.
    ///
    /// `anchor` is the bar's button when that is what asked, and nil for the
    /// palette. On an iPad the menu is a popover and UIKit traps on one with no
    /// anchor, so nil gets the middle of the screen, as in `Natives.share`.
    static func pick(over host: UIViewController, from anchor: UIView?, then answer: @escaping (String) -> Void) {
        let delegate = Delegate(answer: answer)
        // Every picker below holds its delegate weakly, so without this the
        // only strong reference dies at the end of this function and the pick
        // answers nobody. Released when the delegate has answered.
        Delegate.alive = delegate

        let menu = UIAlertController(title: nil, message: nil, preferredStyle: .actionSheet)
        menu.addAction(UIAlertAction(title: "Photo Library", style: .default) { _ in
            host.present(library(delegate), animated: true)
        })
        // Absent rather than failing where there is no camera, which includes
        // every Simulator.
        if UIImagePickerController.isSourceTypeAvailable(.camera) {
            menu.addAction(UIAlertAction(title: "Take Photo", style: .default) { _ in
                host.present(camera(delegate), animated: true)
            })
        }
        menu.addAction(UIAlertAction(title: "Choose File", style: .default) { _ in
            host.present(files(delegate), animated: true)
        })
        // Also what an iPad calls when a tap outside the popover closes it.
        menu.addAction(UIAlertAction(title: "Cancel", style: .cancel) { _ in delegate.finish("") })
        if let popover = menu.popoverPresentationController {
            popover.sourceView = anchor ?? host.view
            if anchor == nil {
                popover.sourceRect = CGRect(x: host.view.bounds.midX, y: host.view.bounds.midY, width: 0, height: 0)
                popover.permittedArrowDirections = []
            }
        }
        host.present(menu, animated: true)
    }

    /// PHPicker rather than UIImagePickerController's library, which is why the
    /// library asks no permission. The picker runs in a process of its own and
    /// hands back only what the user chose, so the app never asks for or holds
    /// access to the library. `NSPhotoLibraryUsageDescription` is not required
    /// for it and is not in the Info.plist.
    private static func library(_ delegate: Delegate) -> UIViewController {
        // Constructed without a `photoLibrary:`, so the results carry no asset
        // identifiers: what comes back is bytes rather than a handle into a
        // library the server cannot see.
        var config = PHPickerConfiguration()
        config.filter = .images
        config.selectionLimit = 1
        // The representation the library already holds, rather than a
        // transcode on the way out. The JPEG is this file's own encode.
        config.preferredAssetRepresentationMode = .current
        let picker = PHPickerViewController(configuration: config)
        picker.delegate = delegate
        return picker
    }

    /// The system camera, and the one source that needs a permission: it runs
    /// in this process, so iOS asks with the Info.plist's
    /// `NSCameraUsageDescription` the first time.
    private static func camera(_ delegate: Delegate) -> UIViewController {
        let picker = UIImagePickerController()
        picker.sourceType = .camera
        picker.delegate = delegate
        return picker
    }

    /// Files, as a copy. The picker hands back a file inside this app's own
    /// container, so no security-scoped access is held to anything outside it.
    private static func files(_ delegate: Delegate) -> UIViewController {
        let picker = UIDocumentPickerViewController(forOpeningContentTypes: [.image], asCopy: true)
        picker.allowsMultipleSelection = false
        picker.delegate = delegate
        return picker
    }

    /// A photograph as base64 JPEG, or "" when it will not encode.
    static func encode(photo image: UIImage) -> String {
        image.jpegData(compressionQuality: quality)?.base64EncodedString() ?? ""
    }

    /// A file's picture as base64, or "" for bytes UIKit cannot read as one.
    ///
    /// A PNG stays a PNG. A file in Files is as likely to be a diagram with a
    /// transparent background as a photograph, and JPEG has no transparency.
    /// Everything else is `encode(photo:)`. Both are re-encodes, so the
    /// metadata goes either way.
    static func encode(file data: Data) -> String {
        guard let image = UIImage(data: data) else { return "" }
        guard data.starts(with: [0x89, 0x50, 0x4E, 0x47]) else { return encode(photo: image) }
        return image.pngData()?.base64EncodedString() ?? ""
    }

    /// One pick's callbacks, whichever of the three screens it went to.
    private final class Delegate: NSObject, PHPickerViewControllerDelegate, UIImagePickerControllerDelegate,
        UINavigationControllerDelegate, UIDocumentPickerDelegate
    {
        /// The pick in flight. The menu is modal, so there is never a second.
        static var alive: Delegate?

        private let answer: (String) -> Void
        /// Answering twice would resolve a bridge call that is already settled.
        /// Reachable: a callback that arrives after a dismissal, or a load that
        /// completes late.
        private var answered = false

        init(answer: @escaping (String) -> Void) {
            self.answer = answer
        }

        /// Called from whichever queue the picture arrived on. The hop to main
        /// comes first, so `answered` is only ever touched there.
        func finish(_ base64: String) {
            DispatchQueue.main.async {
                guard !self.answered else { return }
                self.answered = true
                Delegate.alive = nil
                self.answer(base64)
            }
        }

        // --- the photo library --------------------------------------------------

        func picker(_ picker: PHPickerViewController, didFinishPicking results: [PHPickerResult]) {
            picker.dismiss(animated: true)
            guard let provider = results.first?.itemProvider,
                provider.canLoadObject(ofClass: UIImage.self)
            else {
                // A cancel and an unloadable pick answer the same way, because
                // the view treats both as "nothing to insert" and neither is an
                // error worth a strip (shared/rpc-schema.ts assetPick).
                return finish("")
            }
            provider.loadObject(ofClass: UIImage.self) { [weak self] object, error in
                guard let image = object as? UIImage else {
                    if let error { print("[shell] photo pick failed: \(error.localizedDescription)") }
                    return self?.finish("") ?? ()
                }
                self?.finish(ImagePicker.encode(photo: image))
            }
        }

        // --- the camera ---------------------------------------------------------

        func imagePickerController(
            _ picker: UIImagePickerController,
            didFinishPickingMediaWithInfo info: [UIImagePickerController.InfoKey: Any]
        ) {
            picker.dismiss(animated: true)
            let image = info[.originalImage] as? UIImage
            // Off the main queue, because a full-size camera frame takes a
            // visible moment to encode.
            DispatchQueue.global(qos: .userInitiated).async {
                self.finish(image.map { ImagePicker.encode(photo: $0) } ?? "")
            }
        }

        func imagePickerControllerDidCancel(_ picker: UIImagePickerController) {
            picker.dismiss(animated: true)
            finish("")
        }

        // --- Files --------------------------------------------------------------

        func documentPicker(_ controller: UIDocumentPickerViewController, didPickDocumentsAt urls: [URL]) {
            guard let url = urls.first else { return finish("") }
            DispatchQueue.global(qos: .userInitiated).async {
                let data = try? Data(contentsOf: url)
                // The copy is plaintext in this app's container. A picture for
                // a locked note is sealed on the server, and this copy should
                // not outlive the trip there (locking.md §5).
                try? FileManager.default.removeItem(at: url)
                self.finish(data.map { ImagePicker.encode(file: $0) } ?? "")
            }
        }

        func documentPickerWasCancelled(_ controller: UIDocumentPickerViewController) {
            finish("")
        }
    }
}
