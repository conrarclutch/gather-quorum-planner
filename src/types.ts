export type MemberRole = "member" | "owner";
export type RsvpStatus = "going" | "maybe" | "declined";

export interface Member {
  id: string;
  displayName: string;
  role: MemberRole;
}

export interface GroupSession {
  token: string;
  expiresAt: string;
  member: Member;
}

export interface PlannerEvent {
  id: string;
  groupId: string;
  originalTitle: string;
  sourceUrl: string;
  sourceTab: string;
  sourceRow: number;
  sourceId: string;
  sourceDate: string;
  originalDateSerial: number | null;
  dateCaveat: string;
  eventDate: string;
  yearConfidence: string;
  status: string;
  scope: string;
  details: string;
  location: string | null;
  meetingPoint: string | null;
  departureTime: string | null;
  startTime: string | null;
  endTime: string | null;
  returnTime: string | null;
  leader: string | null;
  notes: string | null;
  confirmed: boolean;
  updatedAt: string;
  createdAt: string;
}

export interface PlannerTask {
  id: string;
  groupId: string;
  eventId: string;
  title: string;
  quantity: number;
  category: string;
  suggested: boolean;
  claimedBy: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface Rsvp {
  id: string;
  eventId: string;
  memberId: string;
  status: RsvpStatus;
  count: number;
  rideNeeded: number;
  seatsOffered: number;
  notes: string;
  updatedAt: string;
}

export interface PlannerState {
  member: Member;
  events: PlannerEvent[];
  tasks: PlannerTask[];
  rsvps: Rsvp[];
  members: Member[];
}

export interface RsvpInput {
  status: RsvpStatus;
  count: number;
  rideNeeded: number;
  seatsOffered: number;
  notes: string;
}

export type EventPatch = Partial<Pick<PlannerEvent,
  "location" | "meetingPoint" | "departureTime" | "startTime" | "endTime" | "returnTime" |
  "eventDate" | "leader" | "notes" | "confirmed"
>>;
