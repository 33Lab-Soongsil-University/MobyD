//! Lane layout for the commit graph.
//!
//! Commits arrive newest-first with every child before its parents. We walk
//! them once, keeping a vector of "lanes": each lane remembers which commit it
//! is waiting for. A commit takes the first lane waiting for it (or a fresh
//! one if it is a branch tip). Its first parent inherits that lane and colour;
//! extra parents of a merge either join a lane already waiting for them or
//! open a new lane. Every row records the line segments that cross it so the
//! frontend can draw each row independently (which keeps virtual scrolling
//! cheap).

use serde::Serialize;

/// Segment kinds, drawn inside one row of height `h`:
/// * `Pass`  — from (`from`, top) to (`to`, bottom), a lane passing by.
/// * `Enter` — from (`from`, top) to (node, middle), a child line arriving.
/// * `Leave` — from (node, middle) to (`to`, bottom), a parent line leaving.
#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum SegmentKind {
    Pass,
    Enter,
    Leave,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Segment {
    pub kind: SegmentKind,
    pub from: u16,
    pub to: u16,
    pub color: u16,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct GraphRow {
    pub lane: u16,
    pub color: u16,
    pub segments: Vec<Segment>,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct GraphLayout {
    pub rows: Vec<GraphRow>,
    pub max_lanes: u16,
}

#[derive(Clone)]
struct Lane {
    waiting_for: String,
    color: u16,
}

fn free_slot(lanes: &mut Vec<Option<Lane>>) -> usize {
    if let Some(i) = lanes.iter().position(Option::is_none) {
        i
    } else {
        lanes.push(None);
        lanes.len() - 1
    }
}

/// Compute the layout. `nodes` yields `(hash, parents)` in display order.
pub fn layout<'a, I>(nodes: I) -> GraphLayout
where
    I: IntoIterator<Item = (&'a str, &'a [String])>,
{
    let mut lanes: Vec<Option<Lane>> = Vec::new();
    let mut rows = Vec::new();
    let mut next_color: u16 = 0;
    let mut max_lanes: u16 = 0;

    for (hash, parents) in nodes {
        let waiting: Vec<usize> =
            lanes.iter().enumerate().filter(|(_, l)| l.as_ref().is_some_and(|l| l.waiting_for == hash)).map(|(i, _)| i).collect();

        let (node, node_color) = match waiting.first() {
            Some(&i) => (i, lanes[i].as_ref().map(|l| l.color).unwrap_or(0)),
            None => {
                let slot = free_slot(&mut lanes);
                let color = next_color;
                next_color = next_color.wrapping_add(1);
                (slot, color)
            }
        };

        let mut segments = Vec::new();
        for (i, lane) in lanes.iter().enumerate() {
            if let Some(l) = lane {
                if l.waiting_for == hash {
                    segments.push(Segment { kind: SegmentKind::Enter, from: i as u16, to: node as u16, color: l.color });
                } else {
                    segments.push(Segment { kind: SegmentKind::Pass, from: i as u16, to: i as u16, color: l.color });
                }
            }
        }
        for &i in &waiting {
            lanes[i] = None;
        }

        if let Some((first, rest)) = parents.split_first() {
            lanes[node] = Some(Lane { waiting_for: first.clone(), color: node_color });
            segments.push(Segment { kind: SegmentKind::Leave, from: node as u16, to: node as u16, color: node_color });
            for parent in rest {
                let existing = lanes.iter().position(|l| l.as_ref().is_some_and(|l| &l.waiting_for == parent));
                match existing {
                    Some(j) => {
                        let color = lanes[j].as_ref().map(|l| l.color).unwrap_or(0);
                        segments.push(Segment { kind: SegmentKind::Leave, from: node as u16, to: j as u16, color });
                    }
                    None => {
                        let slot = free_slot(&mut lanes);
                        let color = next_color;
                        next_color = next_color.wrapping_add(1);
                        lanes[slot] = Some(Lane { waiting_for: parent.clone(), color });
                        segments.push(Segment { kind: SegmentKind::Leave, from: node as u16, to: slot as u16, color });
                    }
                }
            }
        }

        max_lanes = max_lanes.max(lanes.len() as u16).max(node as u16 + 1);
        while matches!(lanes.last(), Some(None)) {
            lanes.pop();
        }
        rows.push(GraphRow { lane: node as u16, color: node_color, segments });
    }

    GraphLayout { rows, max_lanes }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn run(spec: &[(&str, &[&str])]) -> GraphLayout {
        let owned: Vec<(String, Vec<String>)> =
            spec.iter().map(|(h, ps)| (h.to_string(), ps.iter().map(|p| p.to_string()).collect())).collect();
        layout(owned.iter().map(|(h, ps)| (h.as_str(), ps.as_slice())))
    }

    #[test]
    fn linear_history_stays_in_lane_zero() {
        let g = run(&[("c", &["b"]), ("b", &["a"]), ("a", &[])]);
        assert!(g.rows.iter().all(|r| r.lane == 0 && r.color == 0));
        assert_eq!(g.max_lanes, 1);
        // root commit has no leaving segment
        assert!(g.rows[2].segments.iter().all(|s| s.kind != SegmentKind::Leave));
    }

    #[test]
    fn merge_opens_and_closes_a_lane() {
        // m merges f into main; f and b both branch from a.
        let g = run(&[("m", &["b", "f"]), ("f", &["a"]), ("b", &["a"]), ("a", &[])]);
        assert_eq!(g.rows[0].lane, 0);
        assert_eq!(g.rows[1].lane, 1, "feature commit gets its own lane");
        assert_eq!(g.rows[2].lane, 0);
        assert_eq!(g.rows[3].lane, 0, "fork point converges back to lane 0");
        let enters: Vec<_> = g.rows[3].segments.iter().filter(|s| s.kind == SegmentKind::Enter).collect();
        assert_eq!(enters.len(), 2, "both lanes enter the fork point");
        assert_ne!(g.rows[1].color, g.rows[0].color);
        assert_eq!(g.max_lanes, 2);
    }

    #[test]
    fn independent_tips_get_separate_lanes_and_reuse_slots() {
        let g = run(&[("x", &["a"]), ("y", &["a"]), ("a", &[]), ("z", &[])]);
        assert_eq!(g.rows[0].lane, 0);
        assert_eq!(g.rows[1].lane, 1);
        assert_eq!(g.rows[2].lane, 0);
        // after `a` all lanes are free, so an unrelated root reuses lane 0
        assert_eq!(g.rows[3].lane, 0);
    }

    #[test]
    fn merge_into_lane_already_waiting() {
        // t1 and t2 are tips; t1 merges p which t2 already waits for.
        let g = run(&[("t2", &["p"]), ("t1", &["q", "p"]), ("p", &["r"]), ("q", &["r"]), ("r", &[])]);
        let merge_leaves: Vec<_> = g.rows[1].segments.iter().filter(|s| s.kind == SegmentKind::Leave).collect();
        assert_eq!(merge_leaves.len(), 2);
        assert!(merge_leaves.iter().any(|s| s.to == 0), "second parent joins t2's lane");
    }
}
