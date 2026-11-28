import { useEffect, useRef } from "react";
import { drawKenPortrait } from "./goal-ken-portrait";

interface Props {
  /** What Ken is asking: the first question, short (see blockingAsk). */
  question: string;
  /** How many more questions wait with it. */
  more?: number;
  /** Take the user to the conversation, where the question waits. */
  onAnswer: () => void;
}

/**
 * Ken (GG Goals) is blocked on a question, shown over the Workers view as a
 * card just under the header, in the same storybook style as his dialogue box
 * (KenDialogue): his thinking face, his name plate saying he needs you, the
 * question on parchment, and a way to the chat to answer it. It stays up
 * until the user goes to the chat (the caller decides when). Announced once
 * when it appears; never takes focus.
 */
export function GoalAskNotice({ question, more = 0, onAnswer }: Props): React.ReactElement {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    if (canvasRef.current) drawKenPortrait(canvasRef.current, "thinking", { plain: true });
  }, []);
  return (
    <div className="goal-ask" role="alert">
      <div className="goal-ask-sign">
        <div className="goal-ask-board">
          <p className="goal-ask-title">Ken needs you</p>
          <span className="goal-ask-ken" aria-hidden="true">
            <canvas ref={canvasRef} />
          </span>
          <div className="goal-ask-text">
            <p className="goal-ask-question">{question}</p>
            {more > 0 && (
              <p className="goal-ask-more">
                {more === 1 ? "And 1 more question" : `And ${more} more questions`}
              </p>
            )}
          </div>
          <button type="button" className="goal-ask-answer" onClick={onAnswer}>
            Answer in Chat
          </button>
        </div>
      </div>
    </div>
  );
}
