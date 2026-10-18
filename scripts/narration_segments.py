"""Bound synthesis inputs while retaining offsets into the displayed text."""
import re

from narration_text import spoken_text

VERSION = 1
SENTENCE_END = re.compile(r'[。！？；\n!?]+|\.(?=\s|$)')
CLAUSE_END = re.compile(r'[，,、：:]')


def bounded_sentences(text, max_chars=80, transform=spoken_text):
    if max_chars < 16:
        raise ValueError('max_chars must be at least 16')
    sentence_ends = [match.end() for match in SENTENCE_END.finditer(text)]
    if not sentence_ends or sentence_ends[-1] != len(text):
        sentence_ends.append(len(text))
    start = 0
    for end in sentence_ends:
        while start < end:
            raw = text[start:end]
            if not raw.strip():
                start = end
                break
            if len(transform(raw)) <= max_chars:
                yield start, end, raw
                start = end
                break
            candidates = [start + match.end() for match in CLAUSE_END.finditer(raw)]
            fitting = [cut for cut in candidates if start < cut < end
                       and text[start:cut].strip()
                       and len(transform(text[start:cut])) <= max_chars]
            if fitting:
                cut = fitting[-1]
            else:
                fitting = [start + match.end() for match in re.finditer(r'\s+', raw)
                           if text[start:start + match.end()].strip()
                           and len(transform(text[start:start + match.end()])) <= max_chars]
                if fitting:
                    cut = fitting[-1]
                    yield start, cut, text[start:cut]
                    start = cut
                    continue
                # Fall back between Chinese characters, never inside an ASCII identifier.
                fitting = [cut for cut in range(start + 1, end)
                           if not (re.match(r'[A-Za-z0-9_./-]', text[cut - 1])
                                   and re.match(r'[A-Za-z0-9_./-]', text[cut]))
                           and text[start:cut].strip()
                           and len(transform(text[start:cut])) <= max_chars]
                if not fitting:
                    raise ValueError(f'An indivisible term exceeds {max_chars} spoken characters: {raw}')
                cut = fitting[-1]
            yield start, cut, text[start:cut]
            start = cut
