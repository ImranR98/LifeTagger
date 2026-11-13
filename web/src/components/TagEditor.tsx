import { useMemo, useState } from "react";
import { Plus, X, Sparkles, Check } from "lucide-react";
import type { Tag, TagSuggestion } from "../api";
import {
  groupTags,
  isValidTag,
  normalizeKey,
  normalizeValue,
  valueNorm,
} from "@shared/tag-format";

type Props = {
  tags: Tag[];
  suggestions?: TagSuggestion[];
  keys?: string[];
  values?: { key: string; value: string }[];
  onChange: (tags: Tag[]) => void;
  onSuggested?: (suggestion: TagSuggestion) => void;
  onRejectSuggestion?: (suggestion: TagSuggestion) => void;
  onConfirmTag?: (tag: Tag) => void;
  disabled?: boolean;
};

export function TagEditor({
  tags,
  suggestions = [],
  keys = [],
  values = [],
  onChange,
  onSuggested,
  onRejectSuggestion,
  onConfirmTag,
  disabled,
}: Props) {
  const [key, setKey] = useState("");
  const [value, setValue] = useState("");
  const [error, setError] = useState<string | null>(null);
  const groups = useMemo(() => groupTags(tags), [tags]);
  const sourceByTag = useMemo(
    () =>
      new Map(
        tags.map((tag) => [
          `${tag.key}\u0000${valueNorm(tag.value)}`,
          tag.source ?? "user",
        ]),
      ),
    [tags],
  );
  const keyOptions = useMemo(
    () =>
      Array.from(
        new Set([
          ...keys,
          ...tags.map((tag) => tag.key),
          ...suggestions.map((s) => s.key),
        ]),
      ).sort(),
    [keys, tags, suggestions],
  );
  const valueOptions = useMemo(() => {
    const wanted = normalizeKey(key);
    return Array.from(
      new Set(
        values
          .filter((entry) => !wanted || entry.key === wanted)
          .map((entry) => entry.value),
      ),
    )
      .filter(
        (entry) =>
          !tags.some(
            (tag) =>
              tag.key === normalizeKey(key) &&
              valueNorm(tag.value) === valueNorm(entry),
          ),
      )
      .slice(0, 40);
  }, [values, key, tags]);

  function addTag(tag: Tag) {
    const clean = {
      key: normalizeKey(tag.key),
      value: normalizeValue(tag.value),
    };
    if (!clean.key || !clean.value) return;
    if (!isValidTag(clean)) {
      setError(
        "Keys must start with a letter and be at most 32 characters; values can be up to 200 characters.",
      );
      return;
    }
    if (
      tags.some(
        (existing) =>
          existing.key === clean.key &&
          valueNorm(existing.value) === valueNorm(clean.value),
      )
    )
      return;
    setError(null);
    onChange([...tags, clean]);
  }

  function removeTag(tag: Tag) {
    onChange(
      tags.filter(
        (existing) =>
          !(
            existing.key === tag.key &&
            valueNorm(existing.value) === valueNorm(tag.value)
          ),
      ),
    );
  }

  function submit(e: React.FormEvent) {
    e.preventDefault();
    addTag({ key, value });
    setValue("");
  }

  const hasSuggestions = suggestions.length > 0;

  return (
    <div className="min-w-0 space-y-3">
      {hasSuggestions && (
        <div>
          <div className="mb-2 flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-teal-300">
            <Sparkles size={13} /> Suggested from your library
          </div>
          <div className="grid grid-cols-1 gap-2">
            {suggestions.map((suggestion) => (
              <div
                key={`${suggestion.key}:${suggestion.value}`}
                className="suggestion"
              >
                <button
                  type="button"
                  className="min-w-0 flex-1"
                  disabled={disabled}
                  onClick={() => {
                    addTag(suggestion);
                    onSuggested?.(suggestion);
                  }}
                >
                  <span className="flex min-w-0 items-center gap-2 text-sm font-semibold">
                    <Check size={15} className="shrink-0 text-teal-300" />
                    <span className="min-w-0 max-w-[45%] shrink truncate text-teal-300">
                      {suggestion.key}
                    </span>
                    <span className="min-w-0 flex-1 truncate">
                      {suggestion.value}
                    </span>
                    <span className="ml-auto shrink-0 rounded-full bg-teal-300/10 px-2 py-0.5 text-[10px] font-bold text-teal-200">
                      {Math.round(suggestion.score * 100)}%
                    </span>
                  </span>
                  <span className="suggestion-reason mt-0.5 block">
                    {suggestion.reason}
                  </span>
                </button>
                {onRejectSuggestion && (
                  <button
                    type="button"
                    aria-label={`Dismiss suggestion ${suggestion.key}=${suggestion.value}`}
                    className="rounded-lg p-1.5 text-slate-500 hover:bg-white/5 hover:text-slate-200"
                    onClick={() => onRejectSuggestion(suggestion)}
                  >
                    <X size={15} />
                  </button>
                )}
              </div>
            ))}
          </div>
        </div>
      )}

      <div>
        <div className="mb-2 text-xs font-semibold uppercase tracking-wide text-slate-500">
          Tags
        </div>
        {groups.length === 0 ? (
          <p className="text-sm text-slate-500">
            No tags yet. Add one below or tap a suggestion.
          </p>
        ) : (
          <div className="flex min-w-0 flex-wrap gap-2">
            {groups.flatMap((group) =>
              group.values.map((value) => (
                <span key={`${group.key}:${value}`} className="chip">
                  <span className="chip-key">{group.key}</span>
                  <span className="min-w-0 break-words">{value}</span>
                  {(() => {
                    const source =
                      sourceByTag.get(
                        `${group.key}\u0000${valueNorm(value)}`,
                      ) ?? "user";
                    if (source !== "face-auto" && source !== "place-auto")
                      return null;
                    return (
                      <button
                        type="button"
                        className="chip-auto"
                        disabled={disabled || !onConfirmTag}
                        title="Auto-generated. Click to confirm."
                        onClick={() =>
                          onConfirmTag?.({ key: group.key, value })
                        }
                      >
                        AUTO
                      </button>
                    );
                  })()}
                  <button
                    type="button"
                    className="chip-remove"
                    aria-label={`Remove ${group.key}=${value}`}
                    onClick={() => removeTag({ key: group.key, value })}
                  >
                    <X size={12} />
                  </button>
                </span>
              )),
            )}
          </div>
        )}
      </div>

      <form
        onSubmit={submit}
        className="grid grid-cols-[minmax(0,0.75fr)_minmax(0,1.25fr)_auto] gap-2"
      >
        <input
          className="input"
          list="tag-keys"
          aria-label="Tag key"
          maxLength={32}
          placeholder="key"
          value={key}
          onChange={(e) => setKey(e.target.value)}
          autoCapitalize="none"
          spellCheck={false}
        />
        <datalist id="tag-keys">
          {keyOptions.map((option) => (
            <option key={option} value={option} />
          ))}
        </datalist>
        <input
          className="input"
          list="tag-values"
          aria-label="Tag value"
          maxLength={200}
          placeholder={key ? `${key} value` : "value"}
          value={value}
          onChange={(e) => setValue(e.target.value)}
          autoCapitalize="sentences"
        />
        <datalist id="tag-values">
          {valueOptions.map((option) => (
            <option key={option} value={option} />
          ))}
        </datalist>
        <button
          type="submit"
          className="btn"
          disabled={disabled || !key.trim() || !value.trim()}
          aria-label="Add tag"
        >
          <Plus size={18} />
        </button>
      </form>
      {error && (
        <p role="alert" className="text-xs text-rose-300">
          {error}
        </p>
      )}
      <p className="text-[11px] text-slate-500">
        Keys are lowercase slugs. Values can contain spaces, commas, and
        apostrophes.
      </p>
    </div>
  );
}
