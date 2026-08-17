#pragma once

#include <cstddef>
#include <map>
#include <optional>
#include <string>
#include <string_view>
#include <utility>
#include <variant>
#include <vector>

namespace dsh_desktop {
namespace json {

struct Value;

using Array = std::vector<Value>;
using Object = std::map<std::wstring, Value>;

/**
 * Recursive JSON value. The variant lives in a wrapper struct so the recursive
 * Array/Object alternatives are not re-declared over a class-name; constructors
 * make construction from parser code direct.
 */
struct Value {
  using Storage = std::variant<std::nullptr_t, bool, double, std::wstring, Array, Object>;
  Storage data;

  Value() : data(nullptr) {}
  Value(std::nullptr_t) : data(nullptr) {}
  Value(bool value) : data(value) {}
  Value(double value) : data(value) {}
  Value(std::wstring value) : data(std::move(value)) {}
  Value(Array value) : data(std::move(value)) {}
  Value(Object value) : data(std::move(value)) {}
};

/** Parse a complete JSON document; nullopt on any syntax error. */
std::optional<Value> Parse(std::wstring_view text);

inline bool IsString(const Value& v) { return std::holds_alternative<std::wstring>(v.data); }
inline bool IsBool(const Value& v) { return std::holds_alternative<bool>(v.data); }
inline bool IsNumber(const Value& v) { return std::holds_alternative<double>(v.data); }
inline bool IsArray(const Value& v) { return std::holds_alternative<Array>(v.data); }
inline bool IsObject(const Value& v) { return std::holds_alternative<Object>(v.data); }

inline const std::wstring* AsString(const Value& v) { return std::get_if<std::wstring>(&v.data); }
inline const bool* AsBool(const Value& v) { return std::get_if<bool>(&v.data); }
inline const double* AsNumber(const Value& v) { return std::get_if<double>(&v.data); }
inline const Array* AsArray(const Value& v) { return std::get_if<Array>(&v.data); }
inline const Object* AsObject(const Value& v) { return std::get_if<Object>(&v.data); }

/** Look up a key in an object; nullptr when absent. */
inline const Value* Find(const Object& obj, const wchar_t* key) {
  const auto it = obj.find(key);
  return it == obj.end() ? nullptr : &it->second;
}

}  // namespace json
}  // namespace dsh_desktop
