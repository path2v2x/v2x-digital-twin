import type { Metadata } from "next";

import { DetectionReview } from "./DetectionReview";

export const metadata: Metadata = {
  title: "Richmond Field Station detections",
  description: "Detections from the Richmond Field Station V2X cameras, with their recorded footage.",
};

export default function Page() {
  return <DetectionReview />;
}
