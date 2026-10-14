import { OBJECT_PROFILE_KEY_VALUES_BY_BASE_OBJECT_TYPE } from "@rainver/protocol";

/**
 * The subtype keys an Object Profile may use for its base object type. The
 * protocol owns the table; `ck_space_object_profiles_key_by_base_object_type`
 * holds the same rows in the database.
 */
export function allowedObjectProfileKeys(baseObjectType: string): readonly string[] | null {
  return OBJECT_PROFILE_KEY_VALUES_BY_BASE_OBJECT_TYPE[
    baseObjectType as keyof typeof OBJECT_PROFILE_KEY_VALUES_BY_BASE_OBJECT_TYPE
  ] ?? null;
}
