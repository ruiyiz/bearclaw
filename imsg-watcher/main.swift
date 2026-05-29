import Darwin
import Foundation
import SQLite3

let home = FileManager.default.homeDirectoryForCurrentUser.path
let dbPath = "\(home)/Library/Messages/chat.db"
let outputPath = "\(home)/.bearclaw/var/log/imsg-watch.jsonl"
let appleEpochOffset: TimeInterval = 978_307_200
let debounceInterval: TimeInterval = 0.25

try? FileManager.default.createDirectory(
    atPath: "\(home)/.bearclaw/var/log",
    withIntermediateDirectories: true
)

if !FileManager.default.fileExists(atPath: outputPath) {
    FileManager.default.createFile(atPath: outputPath, contents: nil)
}

guard let outputFile = FileHandle(forWritingAtPath: outputPath) else {
    fputs("ERROR: Cannot open output file\n", stderr)
    exit(1)
}
outputFile.seekToEndOfFile()

// MARK: - TypedStreamParser (from steipete/imsg)

func parseAttributedBody(_ data: Data) -> String {
    guard !data.isEmpty else { return "" }
    let bytes = [UInt8](data)
    let start: [UInt8] = [0x01, 0x2b]
    let end: [UInt8] = [0x86, 0x84]
    var best = ""

    var index = 0
    while index + 1 < bytes.count {
        if bytes[index] == start[0], bytes[index + 1] == start[1] {
            let sliceStart = index + 2
            if let sliceEnd = findSequence(end, in: bytes, from: sliceStart) {
                var segment = Array(bytes[sliceStart..<sliceEnd])
                if segment.count > 1, Int(segment[0]) == segment.count - 1 {
                    segment.removeFirst()
                }
                let candidate = String(decoding: segment, as: UTF8.self)
                    .trimmingLeadingControlChars()
                if candidate.count > best.count {
                    best = candidate
                }
            }
        }
        index += 1
    }

    if !best.isEmpty { return best }
    return String(decoding: bytes, as: UTF8.self).trimmingLeadingControlChars()
}

func findSequence(_ needle: [UInt8], in haystack: [UInt8], from start: Int) -> Int? {
    guard !needle.isEmpty, start >= 0, start < haystack.count else { return nil }
    let limit = haystack.count - needle.count
    if limit < start { return nil }
    var index = start
    while index <= limit {
        var matched = true
        for offset in 0..<needle.count {
            if haystack[index + offset] != needle[offset] {
                matched = false
                break
            }
        }
        if matched { return index }
        index += 1
    }
    return nil
}

extension String {
    func trimmingLeadingControlChars() -> String {
        var scalars = unicodeScalars
        while let first = scalars.first,
              CharacterSet.controlCharacters.contains(first) || first == "\n" || first == "\r" {
            scalars.removeFirst()
        }
        return String(String.UnicodeScalarView(scalars))
    }
}

// MARK: - Database

func openDB() -> OpaquePointer? {
    var db: OpaquePointer?
    let flags = SQLITE_OPEN_READONLY | SQLITE_OPEN_NOMUTEX
    if sqlite3_open_v2(dbPath, &db, flags, nil) != SQLITE_OK {
        let err = db.flatMap { String(cString: sqlite3_errmsg($0)) } ?? "unknown"
        fputs("ERROR: Cannot open chat.db: \(err)\n", stderr)
        return nil
    }
    sqlite3_busy_timeout(db, 5000)
    return db
}

func getMaxRowID(_ db: OpaquePointer) -> Int64 {
    var stmt: OpaquePointer?
    defer { sqlite3_finalize(stmt) }
    guard sqlite3_prepare_v2(db, "SELECT MAX(ROWID) FROM message", -1, &stmt, nil) == SQLITE_OK,
          sqlite3_step(stmt) == SQLITE_ROW else { return 0 }
    return sqlite3_column_int64(stmt, 0)
}

func appleDate(_ timestamp: Int64) -> String {
    let seconds = Double(timestamp) / 1_000_000_000.0 + appleEpochOffset
    let date = Date(timeIntervalSince1970: seconds)
    let fmt = ISO8601DateFormatter()
    fmt.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
    return fmt.string(from: date)
}

func escapeJSON(_ s: String) -> String {
    var result = ""
    result.reserveCapacity(s.count)
    for ch in s.unicodeScalars {
        switch ch {
        case "\"": result += "\\\""
        case "\\": result += "\\\\"
        case "\n": result += "\\n"
        case "\r": result += "\\r"
        case "\t": result += "\\t"
        default:
            if ch.value < 0x20 {
                result += String(format: "\\u%04x", ch.value)
            } else {
                result.unicodeScalars.append(ch)
            }
        }
    }
    return result
}

// MARK: - Polling

var cursor: Int64 = 0

func poll() {
    guard let db = openDB() else { return }
    defer { sqlite3_close(db) }

    let query = """
        SELECT m.ROWID, IFNULL(m.text, '') AS text, m.is_from_me, m.date, m.guid,
               cmj.chat_id, h.id AS sender, m.cache_has_attachments, m.attributedBody
        FROM message m
        JOIN chat_message_join cmj ON m.ROWID = cmj.message_id
        LEFT JOIN handle h ON m.handle_id = h.ROWID
        WHERE m.ROWID > ?
        ORDER BY m.ROWID ASC
        LIMIT 100
    """
    var stmt: OpaquePointer?
    defer { sqlite3_finalize(stmt) }
    guard sqlite3_prepare_v2(db, query, -1, &stmt, nil) == SQLITE_OK else { return }
    sqlite3_bind_int64(stmt, 1, cursor)

    while sqlite3_step(stmt) == SQLITE_ROW {
        let rowid = sqlite3_column_int64(stmt, 0)
        var text = String(cString: sqlite3_column_text(stmt, 1))
        let isFromMe = sqlite3_column_int(stmt, 2) != 0
        let dateVal = sqlite3_column_int64(stmt, 3)
        let guid = sqlite3_column_text(stmt, 4).map { String(cString: $0) }
        let chatId = sqlite3_column_int64(stmt, 5)
        let sender = sqlite3_column_text(stmt, 6).map { String(cString: $0) }
        let hasAttachments = sqlite3_column_int(stmt, 7) != 0

        // Fall back to attributedBody when text is empty
        if text.isEmpty, let blobPtr = sqlite3_column_blob(stmt, 8) {
            let blobLen = Int(sqlite3_column_bytes(stmt, 8))
            let data = Data(bytes: blobPtr, count: blobLen)
            text = parseAttributedBody(data)
        }

        let createdAt = appleDate(dateVal)

        var json = "{"
        json += "\"id\":\(rowid)"
        json += ",\"chat_id\":\(chatId)"
        if !text.isEmpty { json += ",\"text\":\"\(escapeJSON(text))\"" }
        json += ",\"is_from_me\":\(isFromMe)"
        json += ",\"created_at\":\"\(createdAt)\""
        if let s = sender { json += ",\"sender\":\"\(escapeJSON(s))\"" }
        if let g = guid { json += ",\"guid\":\"\(escapeJSON(g))\"" }

        if hasAttachments {
            json += ",\"attachments\":\(fetchAttachments(db, messageRowID: rowid))"
        }

        json += "}\n"

        if let data = json.data(using: .utf8) {
            outputFile.write(data)
        }

        if rowid > cursor { cursor = rowid }
    }
}

func fetchAttachments(_ db: OpaquePointer, messageRowID: Int64) -> String {
    let query = """
        SELECT a.filename, a.mime_type, a.transfer_name
        FROM message_attachment_join maj
        JOIN attachment a ON maj.attachment_id = a.ROWID
        WHERE maj.message_id = ?
    """
    var stmt: OpaquePointer?
    defer { sqlite3_finalize(stmt) }
    guard sqlite3_prepare_v2(db, query, -1, &stmt, nil) == SQLITE_OK else { return "[]" }
    sqlite3_bind_int64(stmt, 1, messageRowID)

    var items: [String] = []
    while sqlite3_step(stmt) == SQLITE_ROW {
        let filename = sqlite3_column_text(stmt, 0).map { String(cString: $0) }
        let mimeType = sqlite3_column_text(stmt, 1).map { String(cString: $0) }
        let transferName = sqlite3_column_text(stmt, 2).map { String(cString: $0) }

        var obj = "{"
        if let f = filename { obj += "\"original_path\":\"\(escapeJSON(f))\"" }
        if let m = mimeType {
            if obj.count > 1 { obj += "," }
            obj += "\"mime_type\":\"\(escapeJSON(m))\""
        }
        if let t = transferName {
            if obj.count > 1 { obj += "," }
            obj += "\"transfer_name\":\"\(escapeJSON(t))\""
        }
        obj += "}"
        items.append(obj)
    }

    return "[\(items.joined(separator: ","))]"
}

// MARK: - File system watching (DispatchSource)

let watchQueue = DispatchQueue(label: "imsg-watcher", qos: .userInitiated)
var pending = false

func schedulePoll() {
    if pending { return }
    pending = true
    watchQueue.asyncAfter(deadline: .now() + debounceInterval) {
        pending = false
        poll()
    }
}

func watchFile(_ path: String) -> DispatchSourceFileSystemObject? {
    let fd = open(path, O_EVTONLY)
    guard fd >= 0 else { return nil }
    let source = DispatchSource.makeFileSystemObjectSource(
        fileDescriptor: fd,
        eventMask: [.write, .extend, .rename, .delete],
        queue: watchQueue
    )
    source.setEventHandler { schedulePoll() }
    source.setCancelHandler { close(fd) }
    source.resume()
    return source
}

// MARK: - Main

guard let db = openDB() else { exit(1) }
cursor = getMaxRowID(db)
sqlite3_close(db)

fputs("ImsgWatcher started, cursor at rowid \(cursor)\n", stderr)

let _sources = [dbPath, dbPath + "-wal", dbPath + "-shm"].compactMap { watchFile($0) }
if _sources.isEmpty {
    fputs("ERROR: Could not watch any database files\n", stderr)
    exit(1)
}

dispatchMain()
