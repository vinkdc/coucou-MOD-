// Talks the Ask view offers on a fresh conversation. Same ids as tutor::SCENARIOS in Rust.

export interface Scenario {
  id: string;
  label: string;
  jp: string;
  blurb: string;
  /** Sent (hidden) to start the conversation. */
  opener: string;
}

export const SCENARIOS: Scenario[] = [
  { id: "free", label: "Free talk", jp: "雑談", blurb: "Chat about anything you like.", opener: "Let's start a free conversation. Greet me and ask me something simple." },
  { id: "intro", label: "Introduce yourself", jp: "自己紹介", blurb: "Names, where you're from, hobbies.", opener: "Let's start the self-introduction scenario." },
  { id: "cafe", label: "At a café", jp: "カフェ", blurb: "Order a drink in Tokyo.", opener: "Let's start the café scenario. Welcome me in." },
  { id: "directions", label: "Asking directions", jp: "道案内", blurb: "Find your way near a station.", opener: "Let's start the directions scenario." },
  { id: "shopping", label: "Shopping", jp: "買い物", blurb: "Prices, sizes and paying.", opener: "Let's start the shopping scenario. Greet me as I walk in." },
  { id: "routine", label: "Daily routine", jp: "毎日", blurb: "Mornings, meals, weekends.", opener: "Let's start the daily routine scenario." },
];
