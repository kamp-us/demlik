// The only C++ boundary is ICU77's BasicTimeZone local-offset operation.
// Date parsing, calendar arithmetic, TimeClip and formatting remain in Rust.
#include <cstdint>
#include <unicode/basictz.h>
#include <unicode/timezone.h>
#include <unicode/unistr.h>
#include <unicode/utypes.h>

extern "C" {
void* demlik_icu77_timezone_open(const uint16_t* id, int32_t length,
                               bool use_default, int32_t* error) noexcept {
  icu::TimeZone* zone;
  if (use_default) {
    // Match Node22's ICUTimezoneCache::GetTimeZone, including ICU's host
    // default/unknown-zone behavior. No global default is overwritten here.
    zone = icu::TimeZone::createDefault();
  } else {
    const icu::UnicodeString name(reinterpret_cast<const char16_t*>(id), length);
    if (name.isBogus()) {
      *error = U_MEMORY_ALLOCATION_ERROR;
      return nullptr;
    }
    // ICU deliberately maps unknown IDs to Etc/Unknown with zero offset.
    zone = icu::TimeZone::createTimeZone(name);
  }
  *error = zone == nullptr ? U_MEMORY_ALLOCATION_ERROR : U_ZERO_ERROR;
  return zone;
}

void demlik_icu77_timezone_close(void* zone) noexcept {
  delete static_cast<icu::TimeZone*>(zone);
}

int32_t demlik_icu77_timezone_id(const void* zone, uint16_t* output,
                               int32_t capacity, int32_t* error) noexcept {
  icu::UnicodeString id;
  static_cast<const icu::TimeZone*>(zone)->getID(id);
  if (id.isBogus()) {
    *error = U_MEMORY_ALLOCATION_ERROR;
    return 0;
  }
  if (capacity < id.length()) {
    *error = U_BUFFER_OVERFLOW_ERROR;
  } else {
    for (int32_t i = 0; i < id.length(); ++i) output[i] = id.charAt(i);
    *error = U_ZERO_ERROR;
  }
  return id.length();
}

int64_t demlik_icu77_timezone_local_offset(const void* zone, double local_ms,
                                         int32_t* error) noexcept {
  int32_t raw = 0;
  int32_t daylight = 0;
  UErrorCode status = U_ZERO_ERROR;
  // Every TimeZone created by these ICU factories is a BasicTimeZone. Node22
  // uses the same cast and FORMER/FORMER choices for both gaps and folds.
  const auto* time_zone = static_cast<const icu::TimeZone*>(zone);
  static_cast<const icu::BasicTimeZone*>(time_zone)->getOffsetFromLocal(
      local_ms, UCAL_TZ_LOCAL_FORMER, UCAL_TZ_LOCAL_FORMER, raw, daylight, status);
  *error = status;
  return static_cast<int64_t>(raw) + daylight;
}

const char* demlik_icu77_timezone_data_version(int32_t* error) noexcept {
  UErrorCode status = U_ZERO_ERROR;
  const char* version = icu::TimeZone::getTZDataVersion(status);
  *error = status;
  return version;
}
}
