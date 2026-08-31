import UIKit

/// The servers this phone knows, for the window where the page cannot list them.
///
/// Managing servers is the connection dialog's job (remote.md §8), and that
/// dialog is React inside a web view that only exists once a connection has
/// been made. This is the same list for the state that breaks the assumption: a
/// phone whose saved server has stopped answering has no page, and without this
/// screen its only control is a retry button that will fail the same way for as
/// long as anyone presses it.
///
/// It selects and it adds. It does not rename, edit or remove, because those
/// are rules, and the rules are in the webview beside the Mac's copy of them
/// (ios.md §4) rather than written twice in two languages. Selecting is not one
/// of them — Swift already picks a record to dial at every launch — and adding
/// is the pairing screen, which is here anyway.
final class ServerListViewController: UIViewController {
    private let servers: [ServerRecord]
    private let selected: String
    /// Dial this one. The caller stores the selection and rebuilds the app
    /// around it, which is what makes tapping the row already selected a retry
    /// rather than a no-op.
    private let onChosen: (String) -> Void
    /// Show the pairing form, empty or pre-filled with a record that has no pin.
    private let onAdd: (String, Int) -> Void

    private let reason = UILabel()
    private let table = UITableView(frame: .zero, style: .insetGrouped)

    init(
        servers: [ServerRecord],
        selected: String,
        because: String?,
        onChosen: @escaping (String) -> Void,
        onAdd: @escaping (String, Int) -> Void
    ) {
        self.servers = servers
        self.selected = selected
        self.onChosen = onChosen
        self.onAdd = onAdd
        super.init(nibName: nil, bundle: nil)
        title = "Servers"
        reason.text = because
        reason.isHidden = because == nil
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) { fatalError("no storyboard") }

    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = .systemGroupedBackground

        // Why this screen is on the screen, when something sent us here. The
        // page's own words, which name the machine and what went wrong with it:
        // "could not reach" with no address is the one message nobody can act
        // on, and the same sentence was already on the page that failed.
        reason.font = .preferredFont(forTextStyle: .callout)
        reason.adjustsFontForContentSizeCategory = true
        reason.textColor = .systemRed
        reason.numberOfLines = 0

        table.dataSource = self
        table.delegate = self
        table.register(UITableViewCell.self, forCellReuseIdentifier: "server")

        // Not a stack view: the table insets its own rows and the label does
        // not, so the two want different margins and laying them out together
        // would give the label the table's or the table's rows the label's.
        view.addSubview(reason)
        view.addSubview(table)
        reason.translatesAutoresizingMaskIntoConstraints = false
        table.translatesAutoresizingMaskIntoConstraints = false
        let guide = view.safeAreaLayoutGuide
        NSLayoutConstraint.activate([
            reason.topAnchor.constraint(equalTo: guide.topAnchor, constant: 12),
            reason.leadingAnchor.constraint(equalTo: guide.leadingAnchor, constant: 20),
            reason.trailingAnchor.constraint(equalTo: guide.trailingAnchor, constant: -20),
            table.leadingAnchor.constraint(equalTo: view.leadingAnchor),
            table.trailingAnchor.constraint(equalTo: view.trailingAnchor),
            table.bottomAnchor.constraint(equalTo: view.bottomAnchor),
            // A hidden view still holds its constraints, and an empty label's
            // height is the font's rather than nothing. So the table is pinned
            // to whichever of the two is actually above it.
            reason.isHidden
                ? table.topAnchor.constraint(equalTo: guide.topAnchor)
                : table.topAnchor.constraint(equalTo: reason.bottomAnchor, constant: 8),
        ])
    }
}

extension ServerListViewController: UITableViewDataSource, UITableViewDelegate {
    // Two sections so that adding reads as an action rather than as a server
    // with a strange name.
    func numberOfSections(in tableView: UITableView) -> Int { 2 }

    func tableView(_ tableView: UITableView, numberOfRowsInSection section: Int) -> Int {
        section == 0 ? servers.count : 1
    }

    func tableView(_ tableView: UITableView, cellForRowAt path: IndexPath) -> UITableViewCell {
        let cell = tableView.dequeueReusableCell(withIdentifier: "server", for: path)
        var content = UIListContentConfiguration.subtitleCell()
        cell.accessoryType = .none
        guard path.section == 0 else {
            content.text = "Add a server"
            content.textProperties.color = .tintColor
            cell.contentConfiguration = content
            return cell
        }
        let server = servers[path.row]
        content.text = server.name.isEmpty ? server.destination : server.name
        // The address under the name, because two servers can share a name and
        // the address is what actually gets dialled. The port only when it is
        // not ssh's, which is the answer almost every row has.
        let where_ = server.port == 0 ? server.destination : "\(server.destination):\(server.port)"
        // A record whose pin was dropped cannot be dialled — connecting would
        // mean trusting whatever answers (remote.md §4) — so the row says so and
        // leads to the form rather than to a connection.
        content.secondaryText = server.hostKey.isEmpty ? "\(where_) (needs pairing again)" : where_
        if server.hostKey.isEmpty { content.secondaryTextProperties.color = .secondaryLabel }
        cell.contentConfiguration = content
        if server.id == selected { cell.accessoryType = .checkmark }
        return cell
    }

    func tableView(_ tableView: UITableView, titleForHeaderInSection section: Int) -> String? {
        section == 0 && !servers.isEmpty ? "Connect to" : nil
    }

    func tableView(_ tableView: UITableView, didSelectRowAt path: IndexPath) {
        tableView.deselectRow(at: path, animated: true)
        guard path.section == 0 else { return onAdd("", 0) }
        let server = servers[path.row]
        // Pre-filled with what the record already says: an unpinned record's
        // address is still the one the user meant, and its key is the thing to
        // look at again.
        if server.hostKey.isEmpty { return onAdd(server.destination, server.port) }
        onChosen(server.id)
    }
}
