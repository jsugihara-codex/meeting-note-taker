import type { Metadata } from "next";
import { MeetingRecorder } from "./meeting-recorder";

export const metadata: Metadata = {
  title: "Meeting Room | Live meeting intelligence",
  description:
    "Record, transcribe, annotate, and explore a meeting while it is happening.",
};

export default function Home() {
  return <MeetingRecorder />;
}
