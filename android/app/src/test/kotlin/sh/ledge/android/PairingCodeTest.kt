package sh.ledge.android

import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Test
import java.io.File

/**
 * PairingCode.kt against shared/pairing.vectors.json: the links both other
 * readers answer to, and the pin rule's cases that pairing.swift.test.ts runs
 * through the iPhone's reader (remote.md §4b). A failure names the vector.
 */
class PairingCodeTest {
    private val file = JSONObject(File(System.getProperty("ledge.repo"), "src/shared/pairing.vectors.json").readText())

    @Test
    fun readsEveryVectorAsTheOtherReadersDo() {
        val vectors = file.getJSONArray("vectors")
        for (i in 0 until vectors.length()) {
            val vector = vectors.getJSONObject(i)
            val expected = vector.optJSONObject("code")?.let { code ->
                PairingCode.Read.Code(
                    PairingCode(
                        user = code.getString("user"),
                        host = code.getString("host"),
                        port = code.getInt("port"),
                        fingerprints = code.getJSONArray("fingerprints").strings(),
                    ),
                )
            } ?: PairingCode.Read.Problem(vector.getString("problem"))
            assertEquals(vector.getString("name"), expected, PairingCode.read(vector.getString("link")))
        }
    }

    @Test
    fun neverReplacesAPinThePhoneAlreadyHas() {
        val matches = file.getJSONObject("matches")
        val code = (PairingCode.read(matches.getString("link")) as PairingCode.Read.Code).code
        val cases = matches.getJSONArray("cases")
        for (i in 0 until cases.length()) {
            val case = cases.getJSONObject(i)
            val known = case.getJSONArray("known").let { rows ->
                (0 until rows.length()).map { rows.getJSONObject(it) }.map {
                    PairingCode.Known(it.getString("id"), it.getString("destination"), it.getInt("port"), it.getString("fingerprint"))
                }
            }
            val want = case.getJSONObject("expected")
            val expected = when {
                want.has("new") -> PairingCode.Match.New
                want.has("pinned") -> PairingCode.Match.Pinned(want.getString("pinned"))
                want.has("unpinned") -> PairingCode.Match.Unpinned(want.getString("unpinned"))
                else -> PairingCode.Match.Conflict(want.getString("conflict"))
            }
            assertEquals(case.getString("name"), expected, code.match(known))
        }
    }

    private fun JSONArray.strings(): List<String> = (0 until length()).map { getString(it) }
}
