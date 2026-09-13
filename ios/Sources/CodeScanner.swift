import AVFoundation
import UIKit

/// The camera screen that reads a pairing code (remote.md §4b, ios.md §4).
///
/// AVFoundation's QR reader rather than VisionKit's `DataScannerViewController`,
/// which refuses iPads older than an A12 that iOS 17 still runs on. The first
/// frame that reads as a code ends the scan. A QR code that is not one says why
/// and the camera keeps looking.
final class CodeScannerViewController: UIViewController, AVCaptureMetadataOutputObjectsDelegate {
    private let camera: AVCaptureDevice
    private let onCode: (PairingCode) -> Void
    private let session = AVCaptureSession()
    /// `startRunning` and `stopRunning` block until the camera answers, so they
    /// run here rather than on the main queue.
    private let sessionQueue = DispatchQueue(label: "dev.ledge.scanner")
    private let preview: AVCaptureVideoPreviewLayer
    private var rotation: AVCaptureDevice.RotationCoordinator?
    private var rotationWatch: NSKeyValueObservation?
    private let hint = UILabel()
    /// The last text read, so a QR code held in view reports its problem once.
    private var lastRead = ""
    private var found = false

    /// Opens the scanner over `parent`, asking for the camera first if iOS has
    /// not asked yet. A camera that is refused or missing gets an alert rather
    /// than a black screen.
    static func open(over parent: UIViewController, onCode: @escaping (PairingCode) -> Void) {
        guard let camera = AVCaptureDevice.default(for: .video) else {
            return alert(over: parent, "This device has no camera to scan with.", settings: false)
        }
        switch AVCaptureDevice.authorizationStatus(for: .video) {
        case .authorized:
            let screen = CodeScannerViewController(camera: camera, onCode: onCode)
            screen.modalPresentationStyle = .fullScreen
            parent.present(screen, animated: true)
        case .notDetermined:
            // A "Don't Allow" in the system prompt is its own answer, so only a
            // yes goes anywhere.
            AVCaptureDevice.requestAccess(for: .video) { granted in
                guard granted else { return }
                DispatchQueue.main.async { open(over: parent, onCode: onCode) }
            }
        default:
            alert(over: parent, "Turn on Camera for Ledge in Settings to scan a pairing code.", settings: true)
        }
    }

    private static func alert(over parent: UIViewController, _ message: String, settings: Bool) {
        let alert = UIAlertController(title: "Ledge cannot use the camera", message: message, preferredStyle: .alert)
        if settings, let url = URL(string: UIApplication.openSettingsURLString) {
            alert.addAction(UIAlertAction(title: "Open Settings", style: .default) { _ in UIApplication.shared.open(url) })
        }
        alert.addAction(UIAlertAction(title: settings ? "Cancel" : "OK", style: .cancel))
        parent.present(alert, animated: true)
    }

    private init(camera: AVCaptureDevice, onCode: @escaping (PairingCode) -> Void) {
        self.camera = camera
        self.onCode = onCode
        preview = AVCaptureVideoPreviewLayer(session: session)
        super.init(nibName: nil, bundle: nil)
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) { fatalError("no storyboard") }

    override var preferredStatusBarStyle: UIStatusBarStyle { .lightContent }

    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = .black
        preview.videoGravity = .resizeAspectFill
        view.layer.addSublayer(preview)
        build()

        let output = AVCaptureMetadataOutput()
        guard let input = try? AVCaptureDeviceInput(device: camera), session.canAddInput(input), session.canAddOutput(output)
        else {
            hint.text = "Ledge could not open the camera."
            return
        }
        session.addInput(input)
        session.addOutput(output)
        // After `addOutput`: the types on offer depend on the session's input.
        output.metadataObjectTypes = [.qr]
        output.setMetadataObjectsDelegate(self, queue: .main)

        // The preview turns with the interface, which supports landscape.
        let coordinator = AVCaptureDevice.RotationCoordinator(device: camera, previewLayer: preview)
        rotation = coordinator
        rotationWatch = coordinator.observe(\.videoRotationAngleForHorizonLevelPreview, options: [.initial, .new]) {
            [weak self] coordinator, _ in
            let angle = coordinator.videoRotationAngleForHorizonLevelPreview
            DispatchQueue.main.async { self?.preview.connection?.videoRotationAngle = angle }
        }
    }

    override func viewWillAppear(_ animated: Bool) {
        super.viewWillAppear(animated)
        sessionQueue.async { [session] in session.startRunning() }
    }

    override func viewWillDisappear(_ animated: Bool) {
        super.viewWillDisappear(animated)
        sessionQueue.async { [session] in session.stopRunning() }
    }

    override func viewDidLayoutSubviews() {
        super.viewDidLayoutSubviews()
        preview.frame = view.bounds
    }

    private func build() {
        let cancel = UIButton(configuration: .filled())
        cancel.configuration?.title = "Cancel"
        cancel.configuration?.baseBackgroundColor = UIColor(white: 0.15, alpha: 0.75)
        cancel.configuration?.baseForegroundColor = .white
        cancel.configuration?.cornerStyle = .capsule
        cancel.addAction(UIAction { [weak self] _ in self?.dismiss(animated: true) }, for: .touchUpInside)

        // Where to hold the code. Only a guide: the reader looks at the whole frame.
        let guide = UIView()
        guide.layer.borderColor = UIColor.white.withAlphaComponent(0.9).cgColor
        guide.layer.borderWidth = 3
        guide.layer.cornerRadius = 20
        guide.isUserInteractionEnabled = false

        hint.text = "Point the camera at the pairing code."
        hint.font = .preferredFont(forTextStyle: .body)
        hint.adjustsFontForContentSizeCategory = true
        hint.textColor = .white
        hint.textAlignment = .center
        hint.numberOfLines = 0
        hint.shadowColor = UIColor.black.withAlphaComponent(0.6)
        hint.shadowOffset = CGSize(width: 0, height: 1)

        for sub in [guide, hint, cancel] {
            sub.translatesAutoresizingMaskIntoConstraints = false
            view.addSubview(sub)
        }
        let safe = view.safeAreaLayoutGuide
        let side = guide.widthAnchor.constraint(equalTo: safe.widthAnchor, multiplier: 0.65)
        side.priority = .defaultHigh
        NSLayoutConstraint.activate([
            cancel.topAnchor.constraint(equalTo: safe.topAnchor, constant: 12),
            cancel.leadingAnchor.constraint(equalTo: safe.leadingAnchor, constant: 16),
            guide.centerXAnchor.constraint(equalTo: safe.centerXAnchor),
            guide.centerYAnchor.constraint(equalTo: safe.centerYAnchor),
            guide.heightAnchor.constraint(equalTo: guide.widthAnchor),
            side,
            guide.heightAnchor.constraint(lessThanOrEqualTo: safe.heightAnchor, multiplier: 0.6),
            hint.topAnchor.constraint(equalTo: guide.bottomAnchor, constant: 20),
            hint.leadingAnchor.constraint(equalTo: safe.leadingAnchor, constant: 24),
            hint.trailingAnchor.constraint(equalTo: safe.trailingAnchor, constant: -24),
        ])
    }

    func metadataOutput(
        _ output: AVCaptureMetadataOutput,
        didOutput objects: [AVMetadataObject],
        from connection: AVCaptureConnection
    ) {
        let texts = objects.compactMap { ($0 as? AVMetadataMachineReadableCodeObject)?.stringValue }
        guard !found, let text = texts.first, text != lastRead else { return }
        lastRead = text
        switch PairingCode.read(text) {
        case .code(let code):
            found = true
            UINotificationFeedbackGenerator().notificationOccurred(.success)
            sessionQueue.async { [session] in session.stopRunning() }
            onCode(code)
        case .problem(let problem):
            UINotificationFeedbackGenerator().notificationOccurred(.warning)
            hint.text = problem
        }
    }
}
