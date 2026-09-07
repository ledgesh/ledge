import PhotosUI
import UIKit

/// The photo library, for Insert Image… (ios.md §11).
///
/// PHPicker rather than UIImagePickerController, which is why there is no
/// permission prompt in this file. The picker runs in a process of its own and
/// hands back only what the user chose, so the app never asks for or holds
/// access to the library. `NSPhotoLibraryUsageDescription` is not required for
/// it and is not in the Info.plist.
///
/// Bytes only, as JPEG. The file is the server's to name (remote.md §2), so
/// this answers base64 and the page sends it on to `assetWrite`, which reads
/// the magic and writes `.jpg` (bun/assets.ts extensionFor).
///
/// JPEG because a camera roll holds photographs: the first one inserted from a
/// phone was 3 MB on the device and 28 MB re-encoded losslessly. A screenshot
/// pasted on a Mac is still PNG, where the source really is one.
///
/// Re-encoding rather than forwarding the original file also drops the EXIF, so
/// the GPS coordinates a phone stamps on a picture do not reach the server.
enum PhotoPicker {
    /// Present over `host` and answer base64 JPEG, or "" for a cancel, a
    /// non-image, or a picture the library could not produce.
    static func pick(over host: UIViewController, then answer: @escaping (String) -> Void) {
        // Constructed without a `photoLibrary:`, so the results carry no asset
        // identifiers: what comes back is bytes rather than a handle into a
        // library the server cannot see.
        var config = PHPickerConfiguration()
        config.filter = .images
        config.selectionLimit = 1
        // The representation the library already holds, rather than a transcode
        // on the way out. The JPEG below is this file's own encode.
        config.preferredAssetRepresentationMode = .current

        let picker = PHPickerViewController(configuration: config)
        let delegate = Delegate(answer: answer)
        picker.delegate = delegate
        // PHPickerViewController holds its delegate weakly, so without this the
        // only strong reference dies at the end of this function and the pick
        // answers nobody. Released when the delegate has answered.
        Delegate.alive = delegate
        host.present(picker, animated: true)
    }

    private final class Delegate: NSObject, PHPickerViewControllerDelegate {
        /// The one in flight. `selectionLimit = 1` and a modal picker mean
        /// there is never a second.
        static var alive: Delegate?

        private let answer: (String) -> Void
        /// Answering twice would resolve a bridge call that is already settled.
        /// Reachable: a delegate callback that arrives after a dismissal, or a
        /// load that completes late.
        private var answered = false

        init(answer: @escaping (String) -> Void) {
            self.answer = answer
        }

        private func finish(_ base64: String) {
            guard !answered else { return }
            answered = true
            Delegate.alive = nil
            DispatchQueue.main.async { self.answer(base64) }
        }

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
                // 0.9, which is where JPEG stops being distinguishable from the
                // original by eye and keeps being a tenth of the size.
                guard let image = object as? UIImage, let jpeg = image.jpegData(compressionQuality: 0.9)
                else {
                    if let error { print("[shell] photo pick failed: \(error.localizedDescription)") }
                    return self?.finish("") ?? ()
                }
                self?.finish(jpeg.base64EncodedString())
            }
        }
    }
}
