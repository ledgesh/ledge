// Which machine holds the notes, and how to change it (remote.md §8; the
// interaction grammar is interactions.md §4-1).
//
// A dialog rather than an anchored menu, because most of what it does is
// deliberate rather than quick. Switching tears the session down and rebuilds
// it. Adding or re-addressing a server means reading a host-key fingerprint
// and deciding whether it is the right one. The list is keyboard-first:
// arrows move, Enter switches, ⌫ removes.
//
// Pinning takes two steps (remote.md §4). There is no "connect anyway" that
// remembers, because that button is what pinning exists to prevent.
import { useEffect, useRef, useState, type KeyboardEvent, type RefObject } from "react";
import { Check, Laptop, Loader2, Pencil, Server, Plus, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { pushLayer } from "@/commands/layers";
import {
  addConnection,
  connectionStatus,
  probeConnection,
  removeConnection,
  selectConnection,
  updateConnection,
  type ConnectionStatus,
} from "@/lib/connections";
import { flushAllNow } from "@/notes/store";
import { copyText } from "@/lib/clipboard";
import { deviceKeyLine, shareSheet } from "@/lib/shell";
import { hostPart, parsePort, type AuthMode } from "../../shared/connections";
import type { ConnectionInfo } from "../../shared/rpc-schema";

// Turns a thrown value into a sentence to show. Every action here is an RPC,
// and an RPC can reject as well as refuse: the ordinary rejection is Bun taking
// longer than the view's maxRequestTime (main.tsx). The busy flag gates every
// control, so a rejection nothing catches hangs the dialog. Both paths clear it
// and write to the same line of red text (interactions.md §4-1).
function reasonOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

// What a host answered, waiting to be confirmed. Held rather than pinned. The
// step exists so a person looks at `fingerprint` first.
interface Probed {
  hostKey: string;
  fingerprint: string;
  keyType: string;
}

// The sentence a refused switch shows. It gives the count of unsaved notes and
// names the machine they could not reach, because "some notes" is not something
// anyone can act on.
function unsavedRefusal(unsaved: number, machine: string): string {
  const what = unsaved === 1 ? "One note has unsaved changes" : `${unsaved} notes have unsaved changes`;
  return `${what} that could not reach ${machine}. Switching would lose them, so wait for the connection to come back, or copy them out first.`;
}

export function ConnectionPicker({ onClose }: { onClose: () => void }) {
  const [status, setStatus] = useState<ConnectionStatus>(connectionStatus());
  // Null for the list, "new" for the add form, a connection for the edit form.
  const [form, setForm] = useState<ConnectionInfo | "new" | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => pushLayer("dialog", onClose), [onClose]);

  // The machine the unsaved text belongs to, which is the one being left.
  const activeName = status.connections.find((c) => c.id === status.active)?.name ?? "the server";

  const switchTo = async (id: string) => {
    if (busy) return;
    setBusy(true);
    setError("");
    try {
      // Flush before anything is torn down. A switch reloads the page, so text
      // that could not reach the server it belongs to is in no file anywhere:
      // not on that machine, and not in a trash to point at (remote.md §7).
      // Interactions.md §4 calls that irreversible destruction. §4-1 refuses
      // the switch rather than confirming it, and counts this refusal as the
      // third of its three.
      const unsaved = await flushAllNow();
      if (unsaved > 0) {
        setError(unsavedRefusal(unsaved, activeName));
        setBusy(false);
        return;
      }
      // On success this never returns: selectConnection reloads the page, which
      // is how everything server-scoped gets rebuilt. `busy` stays set through
      // it, so the list cannot become clickable between the switch landing and
      // the page going away. The flush argument is the one above run a second
      // time, a no-op that keeps selectConnection's contract.
      const refusal = await selectConnection(id, async () => void (await flushAllNow()));
      if (!refusal) return;
      setError(refusal);
    } catch (err) {
      // A rejected RPC rather than a refusal: Bun took longer than the view's
      // maxRequestTime, or died. It reaches the same red line a refusal does,
      // because `busy` gates every row and the guard at the top of this
      // function. A swallowed rejection would skip the `setBusy(false)` below
      // and disable the list for good, dropping every click without saying why.
      setError(reasonOf(err));
    }
    setBusy(false);
  };

  const remove = async (id: string) => {
    const refusal = await removeConnection(id);
    if (refusal) setError(refusal);
    else setStatus(connectionStatus());
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center bg-black/40 p-6 pt-[12vh]"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Connections"
        className="flex w-full max-w-lg flex-col rounded-lg border bg-background p-4 shadow-xl"
      >
        <h2 className="text-sm font-semibold">Notes on</h2>

        {form ? (
          <ConnectionForm
            existing={form === "new" ? null : form}
            // True when the form is editing the connection this window is on.
            // An edit that also changes how that connection is made re-opens
            // the wire, and `save` below turns the pair into the `reconnected`
            // flag that reloads the page (lib/connections.ts updateConnection).
            serving={form !== "new" && form.id === status.active}
            onCancel={() => setForm(null)}
            onDone={() => {
              setForm(null);
              setStatus(connectionStatus());
            }}
          />
        ) : (
          <>
            <ConnectionList
              status={status}
              busy={busy}
              onPick={switchTo}
              onEdit={(conn) => {
                setError("");
                setForm(conn);
              }}
              onRemove={remove}
            />
            <div className="mt-3 flex items-center justify-between">
              <p className="text-[11px] text-muted-foreground">
                Switching closes every tab and reopens this machine&apos;s.
              </p>
              <Button size="sm" variant="ghost" onClick={() => setForm("new")}>
                <Plus className="mr-1 size-3.5" />
                Add Server…
              </Button>
            </div>
          </>
        )}

        {error && <p className="mt-2 text-[12px] leading-snug text-destructive">{error}</p>}
      </div>
    </div>
  );
}

function ConnectionList({
  status,
  busy,
  onPick,
  onEdit,
  onRemove,
}: {
  status: ConnectionStatus;
  busy: boolean;
  onPick: (id: string) => void;
  onEdit: (conn: ConnectionInfo) => void;
  onRemove: (id: string) => void;
}) {
  const listRef = useRef<HTMLDivElement>(null);

  // Focus opens on the connection in use, so Enter means stay here and moving
  // somewhere else costs an arrow (interactions.md §4-1).
  useEffect(() => {
    listRef.current?.querySelector<HTMLButtonElement>("[data-active=true]")?.focus();
  }, []);

  // Roving focus by hand rather than through useListNav. That hook marks rows
  // `data-list-row`, which puts the command dispatcher into its list domain
  // (commands/CommandProvider.tsx) and would arm every bare row verb in the
  // app, such as ⌫ closing a workspace, inside this dialog.
  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
    e.preventDefault();
    const rows = Array.from(listRef.current?.querySelectorAll<HTMLButtonElement>("[role=option]") ?? []);
    // The index is of the row a focused control belongs to, not of the focused
    // element itself. The edit and remove buttons sit in the tab order beside
    // their row. An arrow pressed from one of them moves from that row.
    const at = rows.findIndex((row) => row.parentElement?.contains(document.activeElement));
    const next = e.key === "ArrowDown" ? at + 1 : at - 1;
    rows[(next + rows.length) % rows.length]?.focus();
  };

  return (
    <div
      ref={listRef}
      role="listbox"
      aria-label="Connections"
      onKeyDown={onKeyDown}
      className="mt-3 flex flex-col gap-0.5"
    >
      {status.connections.map((conn) => (
        <ConnectionRow
          key={conn.id}
          conn={conn}
          active={conn.id === status.active}
          // The connection the user chose, when it is not the one they got. A
          // boot that fell back says so on the row it fell back from. Without
          // it, the chrome's indicator is the only place the failure appears.
          failed={conn.id === status.wanted && status.wanted !== status.active ? status.error : ""}
          busy={busy}
          onPick={() => onPick(conn.id)}
          onEdit={() => onEdit(conn)}
          onRemove={() => onRemove(conn.id)}
        />
      ))}
    </div>
  );
}

function ConnectionRow({
  conn,
  active,
  failed,
  busy,
  onPick,
  onEdit,
  onRemove,
}: {
  conn: ConnectionInfo;
  active: boolean;
  failed: string;
  busy: boolean;
  onPick: () => void;
  onEdit: () => void;
  onRemove: () => void;
}) {
  const local = conn.destination === "";
  const Icon = local ? Laptop : Server;
  return (
    // Presentational, so the listbox's children are still options. The edit and
    // remove buttons are siblings of the row rather than inside it, because a
    // browser will not render a button inside a button.
    <div role="presentation" className="flex items-center gap-0.5">
      <button
        type="button"
        role="option"
        aria-selected={active}
        data-active={active}
        disabled={busy}
        className="flex min-w-0 flex-1 items-center gap-2 rounded-md px-2 py-1.5 text-left text-[13px] hover:bg-accent focus:bg-accent focus:outline-none disabled:opacity-60 touch:min-h-[44px]"
        onClick={onPick}
        onKeyDown={(e) => {
          // ⌫ on a focused row, the same remove verb the workspace strip uses.
          if (e.key !== "Backspace" || local) return;
          e.preventDefault();
          onRemove();
        }}
      >
        <Icon className="size-3.5 shrink-0 text-muted-foreground" />
        <span className="min-w-0 flex-1">
          <span className="block truncate">{conn.name}</span>
          {conn.destination && (
            <span className="block truncate font-mono text-[11px] text-muted-foreground">
              {conn.destination}
              {conn.pinned ? " · pinned" : ""}
              {/* The row names the door when it is the password one. A
                  password connection whose secret is gone looks like a key
                  connection until it is dialled. */}
              {conn.auth === "password" ? " · password" : ""}
            </span>
          )}
          {failed && <span className="block truncate text-[11px] text-destructive">{failed}</span>}
        </span>
        {active && <Check className="size-3.5 shrink-0" />}
      </button>
      {/* Always drawn, never revealed by a hover. A touch client has no hover,
          and the row verb these mirror (⌫) has no touch form either
          (interactions.md §1a). The local row has neither button, because there
          is nothing about the server in this process to change. */}
      {!local && (
        <>
          <RowButton label={`Edit ${conn.name}`} disabled={busy} onClick={onEdit}>
            <Pencil className="size-3.5" />
          </RowButton>
          <RowButton label={`Remove ${conn.name}`} disabled={busy} destructive onClick={onRemove}>
            <Trash2 className="size-3.5" />
          </RowButton>
        </>
      )}
    </div>
  );
}

function RowButton({
  label,
  disabled,
  destructive,
  onClick,
  children,
}: {
  label: string;
  disabled: boolean;
  destructive?: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      title={label}
      aria-label={label}
      disabled={disabled}
      onClick={onClick}
      // 44 points on touch, and Remove is why. The row is three adjacent
      // alternatives half a point apart: switch to the machine, edit it, remove
      // it. Interactions.md §1a orders such a group by what a miss costs, so
      // Edit sits between the switch and the destructive one.
      className={`flex shrink-0 items-center justify-center rounded-md p-1.5 text-muted-foreground hover:bg-accent focus:bg-accent focus:outline-none disabled:opacity-60 touch:size-[44px] ${
        destructive ? "hover:text-destructive focus:text-destructive" : "hover:text-foreground focus:text-foreground"
      }`}
    >
      {children}
    </button>
  );
}

/**
 * One server's fields, for adding a new one or changing an existing one.
 *
 * The same form both ways, because the second step asks the same question:
 * whether the address names a host this connection has no pin for. That holds
 * for every new connection and for an edit that moved one. A rename, or a
 * change of account on the same host (`dev@box` to `ledge@box`), saves in one
 * step.
 */
function ConnectionForm({
  existing,
  serving,
  onCancel,
  onDone,
}: {
  existing: ConnectionInfo | null;
  serving: boolean;
  onCancel: () => void;
  onDone: () => void;
}) {
  const [name, setName] = useState(existing?.name ?? "");
  const [destination, setDestination] = useState(existing?.destination ?? "");
  // Text, not a number: an empty field is "let ssh decide" and has to stay
  // distinguishable from a half-typed one (shared/connections.ts parsePort).
  const [portText, setPortText] = useState(existing?.port ? String(existing.port) : "");
  const [keyPath, setKeyPath] = useState(existing?.keyPath ?? "");
  const [auth, setAuth] = useState<AuthMode>(existing?.auth ?? "key");
  // Never filled in from the record: a stored password cannot be read back
  // (lib/connections.ts). An empty field on an edit means keep the stored
  // password, which is what every rename sends.
  const [password, setPassword] = useState("");
  const [probed, setProbed] = useState<Probed | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);
  const firstRef = useRef<HTMLInputElement>(null);
  // This client's own key, where it has one. A phone's is in the Secure Enclave
  // and has no path, so its form shows the line to install instead of asking
  // for a file (lib/shell.ts).
  const ownKey = deviceKeyLine();
  const share = shareSheet();

  useEffect(() => firstRef.current?.focus(), []);

  // Null while the field holds something that is not a port. Every action below
  // refuses on it rather than falling back to 22: a typo that silently became
  // the default would connect to the wrong sshd without saying so.
  const port = parsePort(portText);
  const BAD_PORT = "A port is a whole number from 1 to 65535.";

  // A pin belongs to one machine, and known_hosts counts a non-default port as
  // part of which machine (shared/connections.ts). Moving the address or the
  // port leaves nothing to keep, so the fingerprint step comes back. Staying
  // put keeps whatever was pinned, which is the `hostKey: null` that
  // `save(null)` below sends.
  const moved =
    existing !== null &&
    (hostPart(destination.trim()) !== hostPart(existing.destination) || (port !== null && port !== existing.port));
  const mustPin = existing === null || moved;

  const probe = async () => {
    if (port === null) return setError(BAD_PORT);
    setBusy(true);
    setError("");
    let res;
    try {
      res = await probeConnection(destination, port);
    } catch (err) {
      // Same rule as switchTo: a rejection has to end up on screen, or the
      // button it disabled stays disabled and the form is stuck.
      setError(reasonOf(err));
      return;
    } finally {
      setBusy(false);
    }
    if (res.error) return setError(res.error);
    setProbed({ hostKey: res.hostKey, fingerprint: res.fingerprint, keyType: res.keyType });
  };

  // Never trimmed: a leading or trailing space is a legal part of a password,
  // and "" has to keep meaning the field was left alone. Null on the key door
  // says there is nothing to store, which is also what forgets a password when
  // a connection moves off that door (bun/connectionStore.ts swapPassword).
  const typedPassword = auth === "password" && password !== "" ? password : null;

  // Whether leaving the field blank has anything to fall back on. True only for
  // a connection already on the password door: one being switched onto it has
  // nothing stored yet, so it has to be given a password now.
  const storedPassword = existing?.auth === "password";
  const needsPassword = auth === "password" && !storedPassword && password === "";

  const save = async (hostKey: string | null) => {
    if (port === null) return setError(BAD_PORT);
    setBusy(true);
    setError("");
    let refusal: string | null;
    try {
      refusal = existing
        ? await updateConnection(
            { id: existing.id, name, destination, port, keyPath, auth, password: typedPassword, hostKey },
            // A changed address means the wire was re-opened, so this page is
            // now looking at the previous machine's session. Changing the port,
            // the key, the door, or the password re-opens it too, so this list
            // is the same one bun/connectionManager.ts re-dials on
            // (`readdressed` in connectionUpdate).
            {
              reconnected:
                serving &&
                (destination.trim() !== existing.destination ||
                  port !== existing.port ||
                  keyPath.trim() !== existing.keyPath ||
                  auth !== existing.auth ||
                  typedPassword !== null),
              flush: async () => void (await flushAllNow()),
            },
          )
        : (
            await addConnection({
              name,
              destination,
              port,
              keyPath,
              auth,
              password: auth === "password" ? password : "",
              hostKey: hostKey ?? "",
            })
          ).error || null;
    } catch (err) {
      // Same rule as switchTo: a rejection has to end up on screen. An edit
      // that re-dials reaches all the way to ssh, so this is the action most
      // likely to take longer than maxRequestTime allows.
      setError(reasonOf(err));
      return;
    } finally {
      setBusy(false);
    }
    if (refusal) return setError(refusal);
    onDone();
  };

  if (probed) {
    return (
      <div className="mt-3 flex flex-col gap-2">
        <p className="text-[12px] leading-snug">
          {destination} answered with this {probed.keyType || "host"} key. {existing ? "Keep" : "Add"} it only if it
          matches what that machine reports for itself.
        </p>
        <code className="select-text break-all rounded-md border border-input bg-muted/40 p-2 font-mono text-[12px]">
          {probed.fingerprint}
        </code>
        <p className="text-[11px] text-muted-foreground">
          Run <code className="font-mono">ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub</code> there to compare.
        </p>
        {error && <p className="text-[12px] text-destructive">{error}</p>}
        <div className="mt-1 flex justify-end gap-2">
          <Button size="sm" variant="ghost" disabled={busy} onClick={() => setProbed(null)}>
            Back
          </Button>
          <Button size="sm" disabled={busy} onClick={() => void save(probed.hostKey)}>
            {existing ? "It Matches, Save" : "It Matches, Add"}
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div className="mt-3 flex flex-col gap-2">
      {/* Only on the key door. The line installs a key, and a password
          connection offers none: ssh is sent `PubkeyAuthentication=no`
          (bun/connections.ts). Showing it here would ask the user to prepare
          their server for a credential this connection never presents. */}
      {ownKey && auth === "key" && (
        <div className="flex flex-col gap-1">
          {/* The copy says what the line is before what the prefix does. A
              sentence that opens on hardening explains the option before the
              thing it is an option on, and a reader who does not know the line
              carries this device's public key cannot tell why the server needs
              it. The third sentence, on `restrict`, stops short of "cannot
              open a shell" (remote.md §4a). */}
          <span className="text-[11px] text-muted-foreground">
            Add this line to <code className="font-mono">~/.ssh/authorized_keys</code> on the server. It is this
            device's public key, which is how that server knows to let this device in. The{" "}
            <code className="font-mono">restrict</code> prefix keeps the key from forwarding ports or copying files.
          </span>
          <code className="select-text break-all rounded-md border border-input bg-muted/40 p-2 font-mono text-[11px]">
            {ownKey}
          </code>
          <div className="flex gap-1">
            <Button
              size="sm"
              variant="ghost"
              onClick={() => {
                copyText(ownKey);
                setCopied(true);
              }}
            >
              {copied ? "Copied" : "Copy Line"}
            </Button>
            {/* Beside Copy rather than instead of it, and absent on a client
                with no share sheet (lib/shell.ts). Copy suits a server that is
                a window away. A phone's pasteboard ends at the phone, so the
                sheet is how the line reaches the machine it is pasted on
                (ios.md §4). */}
            {share && (
              <Button size="sm" variant="ghost" onClick={() => share(ownKey)}>
                Share Line
              </Button>
            )}
          </div>
        </div>
      )}
      <Field label="Name" value={name} onChange={setName} placeholder="Laptop" inputRef={firstRef} />
      <Field label="SSH destination" value={destination} onChange={setDestination} placeholder="dev@laptop" mono />
      {/* Its own field rather than a `host:port` destination: ssh takes the
          port separately, and every other client's form asks for it that way.
          Empty is the ordinary answer and means ssh decides. */}
      <Field label="Port (optional)" value={portText} onChange={setPortText} placeholder="22" mono />
      <AuthChoice auth={auth} onChange={setAuth} />
      {auth === "password" ? (
        <Field
          label={storedPassword ? "Password (leave blank to keep the stored one)" : "Password"}
          value={password}
          onChange={setPassword}
          placeholder={storedPassword ? "Stored" : "The password for that account"}
          secret
        />
      ) : (
        /* Absent where there is no path to give: a Secure Enclave key cannot be
           read out of the enclave, let alone named by a file (ios.md §4). */
        !ownKey && <Field label="Key (optional)" value={keyPath} onChange={setKeyPath} placeholder="~/.ssh/ledge" mono />
      )}
      {/* No prose under the fields: a paragraph here is read by everyone every
          time to be useful to somebody once (interactions.md §4-1). A missing
          ledge-server on the far machine is reported instead by the connection
          that failed, in the words of the machine that refused it
          (bun/connections.ts explainDial). */}
      {error && <p className="text-[12px] leading-snug text-destructive">{error}</p>}
      <div className="mt-1 flex justify-end gap-2">
        <Button size="sm" variant="ghost" onClick={onCancel}>
          Cancel
        </Button>
        {/* This button reads the fingerprint again after a host rotated its
            key: the connection is right and only the pin is stale. Without it
            that costs a delete and a re-add (interactions.md §4-1). */}
        {existing && !mustPin && (
          <Button size="sm" variant="ghost" disabled={busy} onClick={() => void probe()}>
            Check Key Again
          </Button>
        )}
        <Button
          size="sm"
          disabled={busy || !name.trim() || !destination.trim() || needsPassword}
          onClick={() => void (mustPin ? probe() : save(null))}
        >
          {busy && <Loader2 className="mr-1 size-3.5 animate-spin" />}
          {mustPin ? "Continue" : "Save"}
        </Button>
      </div>
    </div>
  );
}

/**
 * Which door this connection goes through (remote.md §4).
 *
 * Radios rather than a segmented control or a select. The choice is exclusive
 * and changes which field comes next. Radios are the one control that arrows
 * between its options and reads as a choice to a screen reader without any of
 * that being written here.
 */
function AuthChoice({ auth, onChange }: { auth: AuthMode; onChange: (a: AuthMode) => void }) {
  return (
    <fieldset className="flex flex-col gap-1">
      <legend className="text-[11px] text-muted-foreground">Sign in with</legend>
      <div className="flex items-center gap-4">
        {(
          [
            ["key", "A key"],
            ["password", "A password"],
          ] as const
        ).map(([value, label]) => (
          <label key={value} className="flex items-center gap-1.5 text-[13px] touch:min-h-[44px]">
            <input
              type="radio"
              name="ledge-connection-auth"
              value={value}
              checked={auth === value}
              onChange={() => onChange(value)}
              className="accent-current"
            />
            {label}
          </label>
        ))}
      </div>
    </fieldset>
  );
}

function Field({
  label,
  value,
  onChange,
  placeholder,
  mono,
  secret,
  inputRef,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  placeholder: string;
  mono?: boolean;
  /** A password field: masked, and kept away from every autofill and
   * autocorrect heuristic that would otherwise treat it as prose. */
  secret?: boolean;
  inputRef?: RefObject<HTMLInputElement>;
}) {
  return (
    <label className="flex flex-col gap-1">
      <span className="text-[11px] text-muted-foreground">{label}</span>
      <input
        ref={inputRef}
        type={secret ? "password" : "text"}
        // Off rather than "current-password": the field holds the password for
        // somebody else's machine, so the keychain's saved logins for this app
        // would offer the wrong secret from a right-looking list.
        autoComplete={secret ? "off" : undefined}
        value={value}
        placeholder={placeholder}
        spellCheck={false}
        autoCapitalize="off"
        autoCorrect="off"
        onChange={(e) => onChange(e.target.value)}
        className={`rounded-md border border-input bg-transparent px-2 py-1 text-[13px] focus:outline-none focus:ring-1 focus:ring-ring touch:min-h-[44px] ${
          mono ? "font-mono" : ""
        }`}
      />
    </label>
  );
}
