import { useCallback, useEffect, useMemo, useState } from "react";
import { theme } from "./theme";
import { Modal } from "./Modal";
import { mcpElicit, subscribe, type McpElicitAction, type SidecarEvent } from "./agent";

/** One `mcp_elicit` SSE frame: a server asking for input mid tool call. */
interface ElicitRequest {
  id: string;
  server: string;
  message: string;
  requestedSchema: JsonSchemaObject;
}

interface JsonSchemaObject {
  properties?: Record<string, FieldSchema>;
  required?: string[];
}

/** The MCP elicitation primitive-schema vocabulary, as we need it to render. */
interface FieldSchema {
  type?: string;
  title?: string;
  description?: string;
  default?: unknown;
  enum?: string[];
  enumNames?: string[];
  oneOf?: { const: string; title: string }[];
  items?: { type?: string; enum?: string[]; anyOf?: { const: string; title: string }[] };
  format?: string;
  minimum?: number;
  maximum?: number;
  minLength?: number;
  maxLength?: number;
}

type FieldValue = string | number | boolean | string[];

/** Choices for a single- or multi-select field, or null when it isn't one. */
function choicesOf(schema: FieldSchema): { value: string; label: string }[] | null {
  if (schema.oneOf) return schema.oneOf.map((o) => ({ value: o.const, label: o.title }));
  if (schema.enum) {
    return schema.enum.map((value, i) => ({ value, label: schema.enumNames?.[i] ?? value }));
  }
  const items = schema.items;
  if (items?.anyOf) return items.anyOf.map((o) => ({ value: o.const, label: o.title }));
  if (items?.enum) return items.enum.map((value) => ({ value, label: value }));
  return null;
}

function isMultiSelect(schema: FieldSchema): boolean {
  return schema.type === "array";
}

function initialValues(schema: JsonSchemaObject): Record<string, FieldValue> {
  const values: Record<string, FieldValue> = {};
  for (const [name, field] of Object.entries(schema.properties ?? {})) {
    if (field.default !== undefined) {
      values[name] = field.default as FieldValue;
    } else if (isMultiSelect(field)) {
      values[name] = [];
    } else if (field.type === "boolean") {
      values[name] = false;
    } else {
      values[name] = "";
    }
  }
  return values;
}

/** Is every required field filled in? Blank strings and empty lists don't count. */
function isComplete(schema: JsonSchemaObject, values: Record<string, FieldValue>): boolean {
  for (const name of schema.required ?? []) {
    const value = values[name];
    if (value === undefined) return false;
    if (typeof value === "string" && value.trim() === "") return false;
    if (Array.isArray(value) && value.length === 0) return false;
  }
  return true;
}

/**
 * Coerce the form state into the JSON types the schema declares. Number inputs
 * hand back strings, and a server that asked for `integer` must not receive
 * `"3"` — the SDK validates the result against the same schema and would
 * reject the whole response.
 */
function toContent(
  schema: JsonSchemaObject,
  values: Record<string, FieldValue>,
): Record<string, unknown> {
  const content: Record<string, unknown> = {};
  for (const [name, field] of Object.entries(schema.properties ?? {})) {
    const value = values[name];
    if (value === undefined) continue;
    const optional = !(schema.required ?? []).includes(name);
    if (optional && typeof value === "string" && value.trim() === "") continue;
    if (field.type === "number" || field.type === "integer") {
      const parsed = Number(value);
      if (Number.isNaN(parsed)) continue;
      content[name] = field.type === "integer" ? Math.trunc(parsed) : parsed;
      continue;
    }
    content[name] = value;
  }
  return content;
}

/**
 * Modal for MCP `elicitation/create` — a server pausing a tool call to ask the
 * user something. Always mounted: the request arrives unprompted over SSE.
 *
 * The tool call (and with it the whole turn) is blocked until we answer, so
 * every exit path sends one — Escape/backdrop/× send `cancel`.
 *
 * Requests queue rather than stack: two servers can be waiting at once, and a
 * second dialog on top of the first would hide which server is asking.
 */
export function McpElicitModal(): React.ReactElement | null {
  const [queue, setQueue] = useState<ElicitRequest[]>([]);
  const [values, setValues] = useState<Record<string, FieldValue>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const current = queue[0] ?? null;

  useEffect(() => {
    const unsub = subscribe((e: SidecarEvent) => {
      if (e.type !== "mcp_elicit") return;
      const d = e.data as Record<string, unknown>;
      const id = typeof d.id === "string" ? d.id : "";
      if (!id) return;
      setQueue((prev) =>
        prev.some((r) => r.id === id)
          ? prev
          : [
              ...prev,
              {
                id,
                server: String(d.server ?? "an MCP server"),
                message: String(d.message ?? ""),
                requestedSchema: (d.requestedSchema as JsonSchemaObject) ?? {},
              },
            ],
      );
    });
    return () => unsub();
  }, []);

  // Reset the form whenever a new request reaches the head of the queue.
  useEffect(() => {
    setValues(current ? initialValues(current.requestedSchema) : {});
    setError(null);
    setBusy(false);
  }, [current?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  const answer = useCallback(
    async (action: McpElicitAction, content?: Record<string, unknown>): Promise<void> => {
      if (!current || busy) return;
      setBusy(true);
      setError(null);
      try {
        await mcpElicit(current.id, action, content);
        setQueue((prev) => prev.filter((r) => r.id !== current.id));
      } catch (e) {
        // The sidecar 409s once a request has timed out or been cancelled by an
        // abort. Either way this one is finished — drop it rather than trapping
        // the user in a dialog nothing is listening to.
        setError(e instanceof Error ? e.message : String(e));
        setQueue((prev) => prev.filter((r) => r.id !== current.id));
      } finally {
        setBusy(false);
      }
    },
    [current, busy],
  );

  const fields = useMemo(
    () => Object.entries(current?.requestedSchema.properties ?? {}),
    [current?.id], // eslint-disable-line react-hooks/exhaustive-deps
  );

  if (!current) return null;

  const required = new Set(current.requestedSchema.required ?? []);
  const complete = isComplete(current.requestedSchema, values);
  const setValue = (name: string, value: FieldValue): void =>
    setValues((prev) => ({ ...prev, [name]: value }));

  return (
    <Modal title={`${current.server} needs your input`} onClose={() => void answer("cancel")}>
      <div className="login-modal-desc">{current.message}</div>

      {fields.length === 0 && (
        <div className="modal-hint" style={{ color: theme.textMuted }}>
          This server asked for confirmation without any fields.
        </div>
      )}

      {fields.map(([name, field]) => {
        const label = field.title ?? name;
        const choices = choicesOf(field);
        const value = values[name];
        const fieldId = `mcp-elicit-${current.id}-${name}`;
        const describedBy = field.description ? `${fieldId}-desc` : undefined;
        const suffix = required.has(name) ? " *" : "";
        const isBoolean = field.type === "boolean";
        return (
          <div key={name}>
            {/* A checkbox carries its own label text, so a heading above it
                would just say the same thing twice. */}
            {!isBoolean && (
              <label className="modal-label" style={{ color: theme.textMuted }} htmlFor={fieldId}>
                {label}
                {suffix}
              </label>
            )}
            {field.description && (
              <div id={describedBy} className="modal-hint" style={{ color: theme.textMuted }}>
                {field.description}
              </div>
            )}

            {isBoolean && (
              <label className="modal-radio mcp-elicit-boolean">
                <input
                  id={fieldId}
                  type="checkbox"
                  checked={value === true}
                  disabled={busy}
                  aria-describedby={describedBy}
                  onChange={(e) => setValue(name, e.target.checked)}
                />
                <span style={{ color: theme.text }}>
                  {label}
                  {suffix}
                </span>
              </label>
            )}

            {choices && !isBoolean && isMultiSelect(field) && (
              <div className="mcp-elicit-choices" role="group" aria-labelledby={fieldId}>
                {choices.map((choice) => {
                  const selected = Array.isArray(value) && value.includes(choice.value);
                  return (
                    <label key={choice.value} className="modal-radio">
                      <input
                        type="checkbox"
                        checked={selected}
                        disabled={busy}
                        onChange={(e) => {
                          const list = Array.isArray(value) ? value : [];
                          setValue(
                            name,
                            e.target.checked
                              ? [...list, choice.value]
                              : list.filter((v) => v !== choice.value),
                          );
                        }}
                      />
                      <span style={{ color: theme.text }}>{choice.label}</span>
                    </label>
                  );
                })}
              </div>
            )}

            {choices && !isBoolean && !isMultiSelect(field) && (
              <select
                id={fieldId}
                className="modal-input"
                style={{ color: theme.text, background: theme.inputBackground }}
                value={typeof value === "string" ? value : ""}
                disabled={busy}
                aria-describedby={describedBy}
                onChange={(e) => setValue(name, e.target.value)}
              >
                <option value="">Select…</option>
                {choices.map((choice) => (
                  <option key={choice.value} value={choice.value}>
                    {choice.label}
                  </option>
                ))}
              </select>
            )}

            {!choices && !isBoolean && (
              <input
                id={fieldId}
                className="modal-input"
                style={{ color: theme.text, background: theme.inputBackground }}
                aria-describedby={describedBy}
                type={
                  field.type === "number" || field.type === "integer"
                    ? "number"
                    : field.format === "email"
                      ? "email"
                      : "text"
                }
                value={typeof value === "boolean" || Array.isArray(value) ? "" : (value ?? "")}
                min={field.minimum}
                max={field.maximum}
                maxLength={field.maxLength}
                disabled={busy}
                onChange={(e) => setValue(name, e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && complete) {
                    void answer("accept", toContent(current.requestedSchema, values));
                  }
                }}
              />
            )}
          </div>
        );
      })}

      {error && (
        <div className="login-status" style={{ color: theme.error }}>
          {error}
        </div>
      )}

      <div className="modal-actions">
        <button className="modal-btn" disabled={busy} onClick={() => void answer("decline")}>
          Decline
        </button>
        <button className="modal-btn" disabled={busy} onClick={() => void answer("cancel")}>
          Cancel
        </button>
        <button
          className="modal-btn primary"
          disabled={busy || !complete}
          onClick={() => void answer("accept", toContent(current.requestedSchema, values))}
        >
          {busy ? "Sending…" : "Send"}
        </button>
      </div>
    </Modal>
  );
}
