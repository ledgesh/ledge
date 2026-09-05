// Which machine you are typing into, and how to change it (remote.md §8).
//
// A dialog rather than an anchored menu, because most of what it does is
// deliberate rather than quick: switching tears the session down and rebuilds
// it, and adding or re-addressing a server means reading a host-key fingerprint
// and deciding whether it is the right one. The list itself stays keyboard-first
// like every other list in the app — arrows move, Enter switches, ⌫ removes.
//
// Pinning is two steps on purpose. Ledge asks the host for its key, shows the
// fingerprint, and pins only after someone says that is the key they expected;
// there is no "connect anyway" that remembers, because that is the thing
// host-key pinning exists to prevent (§4). Editing an address onto a different
// host asks the same question again, for the same reason: a pin is a claim
// about one machine and does not follow a connection to another.
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

// A thrown thing, as a sentence. Every action in this dialog is an RPC, and an
// RPC can reject as well as refuse — Bun taking longer than the view's
// maxRequestTime is the ordinary way (main.tsx). Both have to reach the same
// line of red text, because the state that gates these buttons is cleared on
// the way there.
function reasonOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

// What a host answered, waiting to be confirmed. Held rather than pinned: the
// whole point of the step is that a person looks at `fingerprint` first.
interface Probed {
  hostKey: string;
  fingerprint: string;
  keyType: string;
}

// What a switch says when it will not go: how much writing is at stake and
// where it was headed. Named rather than counted vaguely, because "some notes"
// is not something anyone can act on.
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

  // The machine the unsaved text belongs to, which is the one being LEFT.
  const activeName = status.connections.find((c) => c.id === status.active)?.name ?? "the server";

  const switchTo = async (id: string) => {
    if (busy) return;
    setBusy(true);
    setError("");
    try {
      // Before anything is torn down. A switch reloads the page, and text that
      // could not reach the server it belongs to is in no file anywhere: not on
      // that machine, and not in a trash we could point at (remote.md §7). So
      // this is §4's irreversible destruction, and the app does not offer a
      // one-click path to it.
      //
      // A refusal rather than a confirmation, though the policy allows either,
      // because the confirmation would be the wrong shape here: there is
      // nothing about the switch worth deciding, and everything about the
      // unsaved text worth handling first. It is also the third of §4-1's
      // refusals that keep the app somewhere it can work from.
      const unsaved = await flushAllNow();
      if (unsaved > 0) {
        setError(unsavedRefusal(unsaved, activeName));
        setBusy(false);
        return;
      }
      // On success this never returns: selectConnection reloads the page, which
      // is how everything server-scoped gets rebuilt. Staying busy through it
      // is deliberate — the list must not become clickable again in the moment
      // between the switch landing and the page going away. The flush passed in
      // is the one above, run again: it wrote everything the first time, so the
      // second is a no-op that keeps selectConnection's contract intact.
      const refusal = await selectConnection(id, async () => void (await flushAllNow()));
      if (!refusal) return;
      setError(refusal);
    } catch (err) {
      // A rejected RPC rather than a refusal — Bun took longer than the view's
      // maxRequestTime, or died. It has to reach the same line a refusal does,
      // because the alternative is this dialog going quiet: `busy` gates every
      // row AND the guard at the top of this function, so one swallowed
      // rejection disables the whole list permanently and eats every click
      // after it without ever saying why.
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
            // Editing the machine being served re-opens it, so the page has to
            // start over on the other side of it — the same rebuild a switch
            // gets, and for the same reason (lib/connections.ts).
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

  // Opens on the connection in use, so Enter is "stay here" and moving costs a
  // deliberate arrow — the same stance the host picker takes about running a
  // block on the wrong machine.
  useEffect(() => {
    listRef.current?.querySelector<HTMLButtonElement>("[data-active=true]")?.focus();
  }, []);

  // Roving focus by hand rather than through useListNav: that hook marks rows
  // `data-list-row`, which puts the command dispatcher into its list domain
  // and would arm every bare row verb in the app (⌫ closes a workspace) inside
  // a modal about something else entirely.
  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
    e.preventDefault();
    const rows = Array.from(listRef.current?.querySelectorAll<HTMLButtonElement>("[role=option]") ?? []);
    // By the row a focused control BELONGS to, not by the focused element: the
    // edit and remove buttons are in the tab order beside their row, and an
    // arrow pressed from one of them means the row it is part of.
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
          // The one the user chose, when that is not the one they got: a boot
          // that fell back has to say so on the row it fell back FROM, or the
          // indicator is the only place the failure exists.
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
    // Presentational, so the listbox's children are still options: the two
    // controls are siblings of the row rather than inside it, because a button
    // in a button is not markup a browser agrees to render.
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
              {/* Which door, on the row, because it is the thing about a
                  connection that is otherwise invisible until it fails: a
                  password connection whose secret is gone looks exactly like a
                  key connection until it is dialled. */}
              {conn.auth === "password" ? " · password" : ""}
            </span>
          )}
          {failed && <span className="block truncate text-[11px] text-destructive">{failed}</span>}
        </span>
        {active && <Check className="size-3.5 shrink-0" />}
      </button>
      {/* Always there, never revealed by a hover: a control a pointer has to
          summon is a control a phone cannot reach at all, and the row verb it
          mirrors (⌫) has no touch form either (interactions.md §1a). The local
          server has neither, because it is not a record — it is the server in
          this process, and there is nothing about it to change. */}
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
      // 44 on touch, and Remove is why: this row is three adjacent
      // alternatives half a point apart — switch machine, edit it, delete it —
      // and the third is destructive (§1a orders a group by what a miss
      // costs; here Edit is what sits between the other two).
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
 * The same form both ways because the second step is the same question: what
 * gets pinned is decided by whether the ADDRESS names a host this connection
 * has no pin for, which is true of every new connection and of an edit that
 * moved one. A rename or a re-account (`dev@box` to `ledge@box`) touches no
 * host and saves in one step.
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
  // Never filled in from the record, because a stored password cannot be read
  // back and should not be (lib/connections.ts). Empty on an edit means "keep
  // the one that is stored", which is what every rename sends.
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
  // refuses on it rather than falling back to 22, because a typo that silently
  // becomes the default connects to the wrong sshd and says nothing.
  const port = parsePort(portText);
  const BAD_PORT = "A port is a whole number from 1 to 65535.";

  // A pin belongs to one machine, and known_hosts counts a non-default port as
  // part of which machine (shared/connections.ts). Moving an address or a port
  // leaves nothing to keep, so the fingerprint step comes back; staying put
  // keeps whatever was pinned, which is what `hostKey: null` says below.
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
  // says "there is nothing to store", which is also what forgets a password
  // when a connection moves off it (bun/connectionStore.ts).
  const typedPassword = auth === "password" && password !== "" ? password : null;

  // Whether leaving the field blank has anything to fall back on. Only true for
  // a connection that was ALREADY on the password door: switching one onto it
  // has nothing stored yet, and so has to be told a password now.
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
            // A changed address means the shell re-opened the wire, so this page
            // is now looking at the previous machine's session. Every other way
            // of changing HOW the connection is made re-opens it too, and the
            // list has to be the same one bun/connectionManager.ts re-attaches
            // on: a port, a key, a door, or a new password.
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
      // that re-dials reaches all the way to ssh, so this is the button most
      // able to outlive the view's patience for an answer.
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
          connection offers none: ssh is sent with PubkeyAuthentication=no, so
          showing it here would be asking the user to prepare their server for
          a credential this connection will never present. */}
      {ownKey && auth === "key" && (
        <div className="flex flex-col gap-1">
          {/* What the line IS comes first: a reader who does not know it carries
              this device's public key cannot tell why the server needs it, and
              a sentence that opens on hardening explains the option before the
              thing it is an option on.

              What the prefix narrows is ssh's feature set around the protocol,
              not the protocol: what rides the forced command is terminalAttach
              and runBlock, which is arbitrary code execution as that user by
              design (remote.md §4a). So the second sentence says what the
              restriction is good for and stops short of "cannot open a shell",
              which reads as a guarantee this design does not make. */}
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
            {/* Beside the copy rather than instead of it, and absent on a client
                with no sheet to open (lib/shell.ts). A copy is the right verb
                when the server is a window away; on a phone the pasteboard ends
                at the phone, and this is the button that gets the line to the
                machine it has to be pasted on. */}
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
      {/* Its own field rather than a `host:port` destination, because that is
          what ssh takes and what every other client's form asks for. Empty is
          the ordinary answer and means ssh decides. */}
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
      {/* No prose under the fields. What it used to say — which addresses ssh
          takes, that a blank port means 22, that the far machine needs
          ledge-server on its PATH, where a password is kept — was read by
          everyone every time to be useful to somebody once. The first two the
          labels already carry; the third is a failure the connection now
          reports in the words of the machine that refused it (connections.ts
          explainDial), which is where it is actually wanted; the fourth is
          docs/user/18. */}
      {error && <p className="text-[12px] leading-snug text-destructive">{error}</p>}
      <div className="mt-1 flex justify-end gap-2">
        <Button size="sm" variant="ghost" onClick={onCancel}>
          Cancel
        </Button>
        {/* A host that rotated its key legitimately would otherwise cost a
            delete and a re-add: the connection is right, the pin is stale, and
            this is the step that reads the new one. */}
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
 * Radios rather than a segmented control or a select: it is a two-way exclusive
 * choice that changes which field comes next, and radios are the one control
 * that arrows between its options and reads as a choice to a screen reader
 * without any of it being written here.
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
        // Off rather than "current-password": this is a field for somebody
        // else's machine, and offering the keychain's saved logins for this app
        // would be offering the wrong secret from the right-looking list.
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
