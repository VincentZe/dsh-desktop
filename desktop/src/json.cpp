#include "json.hpp"

#include <cstdlib>
#include <cwctype>

namespace dsh_desktop {
namespace json {
namespace {

int HexDigit(wchar_t c) {
  if (c >= L'0' && c <= L'9') return c - L'0';
  if (c >= L'a' && c <= L'f') return c - L'a' + 10;
  if (c >= L'A' && c <= L'F') return c - L'A' + 10;
  return -1;
}

struct Parser {
  std::wstring_view text;
  std::size_t cursor = 0;

  void SkipWhitespace() {
    while (cursor < text.size() &&
           (text[cursor] == L' ' || text[cursor] == L'\t' ||
            text[cursor] == L'\r' || text[cursor] == L'\n')) {
      ++cursor;
    }
  }

  bool Consume(wchar_t expected) {
    SkipWhitespace();
    if (cursor < text.size() && text[cursor] == expected) {
      ++cursor;
      return true;
    }
    return false;
  }

  bool ParseString(std::wstring& out) {
    SkipWhitespace();
    if (cursor >= text.size() || text[cursor] != L'"') return false;
    ++cursor;
    out.clear();
    while (cursor < text.size()) {
      const wchar_t c = text[cursor++];
      if (c == L'"') return true;
      if (c != L'\\') {
        out.push_back(c);
        continue;
      }
      if (cursor >= text.size()) return false;
      const wchar_t escaped = text[cursor++];
      switch (escaped) {
        case L'"': out.push_back(L'"'); break;
        case L'\\': out.push_back(L'\\'); break;
        case L'/': out.push_back(L'/'); break;
        case L'b': out.push_back(L'\b'); break;
        case L'f': out.push_back(L'\f'); break;
        case L'n': out.push_back(L'\n'); break;
        case L'r': out.push_back(L'\r'); break;
        case L't': out.push_back(L'\t'); break;
        case L'u': {
          if (cursor + 4 > text.size()) return false;
          unsigned int code = 0;
          for (int index = 0; index < 4; ++index) {
            const int digit = HexDigit(text[cursor++]);
            if (digit < 0) return false;
            code = (code << 4U) | static_cast<unsigned int>(digit);
          }
          out.push_back(static_cast<wchar_t>(code));
          break;
        }
        default:
          return false;
      }
    }
    return false;
  }

  bool ParseNumber(double& out) {
    SkipWhitespace();
    const std::size_t start = cursor;
    if (cursor < text.size() && text[cursor] == L'-') ++cursor;
    bool any_digit = false;
    while (cursor < text.size() && text[cursor] >= L'0' && text[cursor] <= L'9') {
      ++cursor;
      any_digit = true;
    }
    if (cursor < text.size() && text[cursor] == L'.') {
      ++cursor;
      while (cursor < text.size() && text[cursor] >= L'0' && text[cursor] <= L'9') {
        ++cursor;
        any_digit = true;
      }
    }
    if (any_digit && cursor < text.size() &&
        (text[cursor] == L'e' || text[cursor] == L'E')) {
      ++cursor;
      if (cursor < text.size() && (text[cursor] == L'+' || text[cursor] == L'-')) ++cursor;
      bool exponent_digit = false;
      while (cursor < text.size() && text[cursor] >= L'0' && text[cursor] <= L'9') {
        ++cursor;
        exponent_digit = true;
      }
      if (!exponent_digit) return false;
    }
    if (!any_digit || start == cursor) return false;
    const std::wstring number(text.substr(start, cursor - start));
    out = std::wcstod(number.c_str(), nullptr);
    return true;
  }

  std::optional<Value> ParseValue();

  std::optional<Value> ParseObject() {
    if (!Consume(L'{')) return std::nullopt;
    Object object;
    if (Consume(L'}')) return Value(std::move(object));
    for (;;) {
      std::wstring key;
      if (!ParseString(key)) return std::nullopt;
      if (!Consume(L':')) return std::nullopt;
      std::optional<Value> value = ParseValue();
      if (!value) return std::nullopt;
      object.emplace(std::move(key), std::move(*value));
      if (Consume(L'}')) return Value(std::move(object));
      if (!Consume(L',')) return std::nullopt;
    }
  }

  std::optional<Value> ParseArray() {
    if (!Consume(L'[')) return std::nullopt;
    Array array;
    if (Consume(L']')) return Value(std::move(array));
    for (;;) {
      std::optional<Value> value = ParseValue();
      if (!value) return std::nullopt;
      array.push_back(std::move(*value));
      if (Consume(L']')) return Value(std::move(array));
      if (!Consume(L',')) return std::nullopt;
    }
  }
};

std::optional<Value> Parser::ParseValue() {
  SkipWhitespace();
  if (cursor >= text.size()) return std::nullopt;
  const wchar_t c = text[cursor];
  if (c == L'"') {
    std::wstring value;
    if (!ParseString(value)) return std::nullopt;
    return Value(std::move(value));
  }
  if (c == L'{') return ParseObject();
  if (c == L'[') return ParseArray();
  if (c == L't') {
    if (text.substr(cursor, 4) == L"true") {
      cursor += 4;
      return Value(true);
    }
    return std::nullopt;
  }
  if (c == L'f') {
    if (text.substr(cursor, 5) == L"false") {
      cursor += 5;
      return Value(false);
    }
    return std::nullopt;
  }
  if (c == L'n') {
    if (text.substr(cursor, 4) == L"null") {
      cursor += 4;
      return Value(nullptr);
    }
    return std::nullopt;
  }
  if (c == L'-' || (c >= L'0' && c <= L'9')) {
    double number = 0.0;
    if (!ParseNumber(number)) return std::nullopt;
    return Value(number);
  }
  return std::nullopt;
}

}  // namespace

std::optional<Value> Parse(std::wstring_view text) {
  Parser parser{text, 0};
  std::optional<Value> value = parser.ParseValue();
  if (!value) return std::nullopt;
  parser.SkipWhitespace();
  if (parser.cursor != text.size()) return std::nullopt;
  return value;
}

}  // namespace json
}  // namespace dsh_desktop
