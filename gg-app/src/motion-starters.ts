/**
 * One-click starting points shown on Motion's empty screen. Each fills the
 * composer rather than sending, so the user can add their link or file first.
 */
export const MOTION_STARTERS = [
  {
    label: "Launch my product",
    prompt:
      "Create a 30-second product launch video from my website. Show who it helps, the problem it solves and the real product in action, ending with one clear call to action. Use my brand and propose a cohesive visual direction before building. Website: ",
  },
  {
    label: "Demo a feature",
    prompt:
      "Create a 20-second feature demo from my screenshots or screen recording. Show the task, the key interaction and the result. Keep the product UI accurate, with focused callouts and readable captions. Carry the product's visual style into any supporting graphics. Feature and files: ",
  },
  {
    label: "Make a social ad",
    prompt:
      "Create a 15-second vertical social ad (9:16) for my product or service. Open with a clear customer problem, show one supported benefit and finish with a call to action. Make it understandable without sound and readable on a phone. Propose a direction that fits my brand. Product, audience and source: ",
  },
  {
    label: "Announce an update",
    prompt:
      "Turn my release notes into a 25-second what's-new video for existing users. Highlight up to three meaningful improvements using real screenshots or supplied assets, explain why they matter and end with how to try them. Keep the design consistent with my product. Release notes and assets: ",
  },
  {
    label: "Showcase my GitHub repo",
    prompt:
      "Create a 30-second showcase for my GitHub project. Explain what it does, show one useful example grounded in the README or demo, and end with an invitation to try it. Use a cohesive visual system and purposeful code or diagram animation, not a wall of text. Repo: ",
  },
  {
    label: "Explain a document",
    prompt:
      "Turn my PDF or document into a 60-second explainer for a non-expert audience. Build a clear story around the main takeaway, using readable captions and diagrams or data graphics where they help. Keep claims traceable to the source and propose the storyboard before building. Document and audience: ",
  },
  {
    label: "Build a launch kit",
    prompt:
      "Create a coordinated launch kit: a 30-second 16:9 product video, 15-second vertical and square social cuts, and a short looping feature demo. Use one approved visual system, accurate product assets and reusable on-brand graphics. Recompose each format for readability rather than just cropping. Product website and assets: ",
  },
] as const;
