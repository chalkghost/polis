import dbPgQuery, {
  queryP_readOnly as pgQueryP_readOnly,
  stream_queryP_readOnly as stream_pgQueryP_readOnly,
} from "../db/pg-query";
import { getZinvite, getZidForRid } from "../utils/zinvite";
import { getPca } from "../utils/pca";
import fail from "../utils/fail";
import logger from "../utils/logger";

type Formatters = Record<string, (row: any) => string>;
const sep = "\n";

function formatCSVHeaders(colFns: Formatters) {
  return Object.keys(colFns).join(",");
}

function formatCSVRow(row: object, colFns: Formatters) {
  const fns = Object.values(colFns);
  let csv = "";
  for (let ii = 0; ii < fns.length; ii += 1) {
    if (ii > 0) csv += ",";
    csv += fns[ii](row);
  }
  return csv;
}

function formatCSV(colFns: Formatters, rows: object[]): string {
  const fns = Object.values(colFns);
  let csv = formatCSVHeaders(colFns) + sep;
  if (rows.length > 0) {
    for (const row of rows) {
      csv += formatCSVRow(row, colFns);
      csv += sep;
    }
  }
  return csv;
}

async function loadConversationSummary(zid: number, siteUrl: string) {
  const [zinvite, convoRows, commentersRow, pca] = await Promise.all([
    getZinvite(zid),
    pgQueryP_readOnly(
      `SELECT topic, description FROM conversations WHERE zid = $1`,
      [zid]
    ),
    pgQueryP_readOnly(
      `SELECT COUNT(DISTINCT pid) FROM comments WHERE zid = $1`,
      [zid]
    ),
    getPca(zid),
  ]);
  if (!zinvite || !convoRows || !commentersRow || !pca) {
    throw new Error("polis_error_data_unknown_report");
  }

  const convo = (convoRows as { topic: string; description: string }[])[0];
  const commenters = (commentersRow as { count: number }[])[0].count;

  type PcaData = {
    "in-conv": number[];
    "user-vote-counts": Record<number, number>;
    "group-clusters": Record<number, object>;
    "n-cmts": number;
  };
  const data = pca.asPOJO as PcaData;

  const escapeQuotes = (s: string) => s.replace(/"/g, '""');
  return [
    ["topic", `"${escapeQuotes(convo.topic)}"`],
    ["url", `${siteUrl}/${zinvite}`],
    ["voters", Object.keys(data["user-vote-counts"]).length],
    ["voters-in-conv", data["in-conv"].length],
    ["commenters", commenters],
    ["comments", data["n-cmts"]],
    ["groups", Object.keys(data["group-clusters"]).length],
    ["conversation-description", `"${escapeQuotes(convo.description)}"`],
  ].map((row) => row.join(","));
}

const formatDatetime = (timestamp: string) =>
  new Date(parseInt(timestamp)).toString();

type Response = {
  setHeader: (key: string, value: string) => void;
  send: (data: string) => void;
  write: (data: string) => void;
  end: () => void;
};

async function sendConversationSummary(
  zid: number,
  siteUrl: string,
  res: Response
) {
  const rows = await loadConversationSummary(zid, siteUrl);
  res.setHeader("content-type", "text/csv");
  res.send(rows.join(sep));
}

async function sendCommentSummary(zid: number, res: Response) {
  const rows = (await pgQueryP_readOnly(
    `SELECT
    created,
    tid,
    pid,
    COALESCE((SELECT count(*) FROM votes WHERE votes.tid = comments.tid AND vote = 1), 0) as agrees,
    COALESCE((SELECT count(*) FROM votes WHERE votes.tid = comments.tid AND vote = -1), 0) as disagrees,
    mod,
    txt
  FROM comments
  WHERE zid = $1`,
    [zid]
  )) as object[] | undefined;
  if (!rows) {
    fail(res, 500, "polis_err_data_export");
    return;
  }

  res.setHeader("content-type", "text/csv");
  res.send(
    formatCSV(
      {
        timestamp: (row) => String(Math.floor(row.created / 1000)),
        datetime: (row) => formatDatetime(row.created),
        "comment-id": (row) => String(row.tid),
        "author-id": (row) => String(row.pid),
        agrees: (row) => String(row.agrees),
        disagrees: (row) => String(row.disagrees),
        moderated: (row) => String(row.mod),
        "comment-body": (row) => String(row.txt),
      },
      rows
    )
  );
}

async function sendVotesSummary(zid: number, res: Response) {
  const formatters: Formatters = {
    timestamp: (row) => String(Math.floor(row.timestamp / 1000)),
    datetime: (row) => formatDatetime(row.timestamp),
    "comment-id": (row) => String(row.tid),
    "voter-id": (row) => String(row.pid),
    vote: (row) => String(row.vote),
  };
  res.setHeader("Content-Type", "text/csv");
  res.write(formatCSVHeaders(formatters) + sep);

  stream_pgQueryP_readOnly(
    "SELECT created as timestamp, tid, pid, vote FROM votes WHERE zid = $1 ORDER BY tid, pid",
    [zid],
    (row) => res.write(formatCSVRow(row, formatters) + sep),
    () => res.end(),
    (error) => {
      // Handle any errors
      logger.error("polis_err_report_votes_csv", error);
      fail(res, 500, "polis_err_data_export", error);
    }
  );
}

export async function handle_GET_reportExport(
  req: {
    p: { rid: string; report_type: string };
    headers: { host: string; "x-forwarded-proto": string };
  },
  res: Response
) {
  const { rid, report_type } = req.p;
  try {
    const zid = await getZidForRid(rid);
    if (!zid) {
      fail(res, 404, "polis_error_data_unknown_report");
      return;
    }

    switch (report_type) {
      case "summary.csv":
        const siteUrl = `${req.headers["x-forwarded-proto"]}://${req.headers.host}`;
        await sendConversationSummary(zid, siteUrl, res);
        break;

      case "comments.csv":
        await sendCommentSummary(zid, res);
        break;

      case "votes.csv":
        await sendVotesSummary(zid, res);
        break;

      default:
        fail(res, 404, "polis_error_data_unknown_report");
        break;
    }
  } catch (err) {
    const msg =
      err instanceof Error && err.message && err.message.startsWith("polis_")
        ? err.message
        : "polis_err_data_export";
    fail(res, 500, msg, err);
  }
}
