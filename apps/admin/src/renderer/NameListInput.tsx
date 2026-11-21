import { useEffect, useState } from 'react';
import { parseNameList } from '@vade/protocol';

/** Textarea "one item per line" that reports a cleaned string[]. */
export function NameListInput({ value, onChange, placeholder, rows = 4 }: { value: string[]; onChange: (v: string[]) => void; placeholder?: string; rows?: number }) {
  const [text, setText] = useState(value.join('\n'));
  const key = value.join('\n');
  useEffect(() => {
    if (parseNameList(text).join('\n') !== key) setText(key);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  return (
    <textarea
      className="input mono"
      rows={rows}
      value={text}
      placeholder={placeholder}
      spellCheck={false}
      onChange={(e) => {
        setText(e.target.value);
        onChange(parseNameList(e.target.value));
      }}
    />
  );
}
