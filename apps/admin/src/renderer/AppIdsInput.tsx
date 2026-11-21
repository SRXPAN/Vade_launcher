import { useEffect, useState } from 'react';
import { parseAppIds } from '@vade/protocol';

/** Text field for "730, 570, 578080" that reports a number[] only when the text is valid. */
export function AppIdsInput({ value, onChange, placeholder }: { value: number[]; onChange: (ids: number[]) => void; placeholder?: string }) {
  const [text, setText] = useState(value.join(', '));
  const [invalid, setInvalid] = useState(false);
  useEffect(() => {
    const parsed = parseAppIds(text);
    if (!parsed || parsed.join(',') !== value.join(',')) setText(value.join(', '));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value.join(',')]);
  return (
    <input
      className={`input mono ${invalid ? 'invalid' : ''}`}
      value={text}
      placeholder={placeholder ?? '730, 570, 578080'}
      onChange={(e) => {
        setText(e.target.value);
        const ids = parseAppIds(e.target.value);
        setInvalid(ids == null);
        if (ids) onChange(ids);
      }}
    />
  );
}
