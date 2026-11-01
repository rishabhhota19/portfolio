"""Gate 2 of the refusal pipeline: is the question about Rishabh's work? Judged by meaning, not keywords.

The question's embedding (already computed for retrieval, so this costs nothing) is compared with two small banks of
example questions — recruiter questions about him, and things people ask chatbots that have nothing to do with him.
If it sits clearly closer to the off-topic examples, and nothing on the site is a close match, it's refused before any
LLM is called. The banks are embedded by `python -m agent.build_index` (agent/data/embeddings/scope.npz); every
embedding route serves the same model, so one bank and one set of thresholds serve them all.

The examples are deliberately different from the test prompts in evals/scope.json, which check this gate.
"""

import re
from functools import lru_cache

import numpy as np

from .embeddings import FOLDER
from .guard import ABOUT_HIM, names_a_page

IN_SCOPE = [
    "What has he worked on recently?", "Tell me about his background", "What are his main skills?",
    "Which programming languages does he use?", "Does he have experience with large language models?",
    "What projects has he shipped to production?", "Has he deployed machine learning models on the cloud?",
    "What research has he published?", "Is he a good fit for a machine learning engineer position?",
    "Would he suit a research scientist role?", "How senior is he?", "What does his current job involve?",
    "What did he do before his current company?", "Tell me about his medical imaging work",
    "Has he built multi-agent systems?", "Which ML frameworks does he know?", "Does he have startup experience?",
    "What results did his projects achieve?", "Has he led a team?", "What awards has he won?", "Where is he based?",
    "What's his education?", "Does he know PyTorch?", "Has he fine-tuned open-source models?",
    "What's the most impressive thing he has built?", "How does the chatbot on this site work?",
    "What is this portfolio built with?", "Tell me more about that project", "What were the results?",
    "Why did he choose that approach?", "Which one had the biggest impact?", "Can you go deeper on the architecture?",
    "And what about his research?", "What tools did he use for it?", "How long was he there?",
    "Is he open to new opportunities?", "Can he work on computer vision problems?", "Does he have NLP experience?",
    "What's his experience with vector databases?", "Has he worked in healthcare?", "What did he do as an intern?",
    "Summarise his profile in three lines", "Why would he be a strong hire?", "What kind of team would he thrive in?",
    "Has he contributed to open source?", "How did he evaluate his models?", "Does he understand MLOps?",
    "What's his notice period?", "What salary is he looking for?", "Would he relocate for a role?",
    "Does he need visa sponsorship?", "What did he learn from his quantum computing research?",
    "Can he build agents with tool calling?", "Has he used retrieval-augmented generation in a real product?",
    "Who is Rishabh?", "Tell me about Rishabh", "Introduce Rishabh in two lines",
]

OUT_OF_SCOPE = [
    # general knowledge
    "What is the tallest mountain in the world?", "When did World War 2 end?", "How far is the moon from earth?",
    "What's the population of India?", "Who invented the telephone?", "Explain how vaccines work",
    "What causes earthquakes?", "Explain blockchain to me", "What is machine learning?",
    "How does a neural network learn?", "What is the difference between AI and ML?", "What does GPU stand for?",
    # coding help
    "Write a function to sort an array", "How do I center a div in CSS?", "Fix my JavaScript error",
    "Give me a regex for email validation", "How do I install pandas?", "Write a bash script to rename files",
    "Build me a todo app in React", "Why is my Python code throwing a KeyError?",
    # creative writing
    "Write a love letter", "Compose a song about friendship", "Tell me a funny story",
    "Write a limerick about cats", "Create a slogan for my bakery", "Write a blog post about travel",
    # advice for the visitor
    "How can I lose weight fast?", "Should I quit my job?", "How do I prepare for a job interview?",
    "What career should I choose?", "How do I invest in mutual funds?", "Is it safe to take ibuprofen every day?",
    "How do I deal with stress at work?", "Give me tips for learning machine learning", "How do I ask for a raise?",
    # entertainment, sport, news, travel
    "Who will win the IPL this year?", "Recommend a good movie to watch tonight", "What's trending on Twitter today?",
    "Latest news about Apple", "Best places to visit in Goa", "Which football club is the best?",
    # assistant chores
    "Set a reminder for 5pm", "Book a flight to Delhi", "Order a pizza for me", "Send an email to my boss",
    "Summarise this article for me", "Translate this paragraph into Hindi", "Plan my weekend trip",
    # other people
    "Tell me about Sundar Pichai", "What is Sam Altman's net worth?", "Who is the richest person in the world?",
    # small talk and role play
    "Let's chat about anything", "Can you be my friend?", "What's your opinion on religion?",
    "Do you have feelings?", "Pretend you are a pirate", "What is the meaning of life?",
    # about him, but not his work
    "Is Rishabh single?", "What does Rishabh look like?", "What car does Rishabh drive?",
    "What are Rishabh's political views?", "Where does Rishabh's family live?",
]

# Tuned for bge-small-en-v1.5 on evals/scope.json: 0 false refusals on the tuned and held-out sets, 0 leaks end to end.
MARGIN = 0.012  # off-topic examples must be this much closer than in-scope ones (cosine) …
ABOUT_HIM_MARGIN = 0.08  # … much closer if the question is about him ("who is Rishabh?") — Gates 3–4 still apply
RELEVANT = 0.72  # … and nothing on the site may be this close (the best chunk's cosine similarity)


@lru_cache
def bank() -> tuple[np.ndarray, np.ndarray] | None:
    path = FOLDER / "scope.npz"
    if not path.exists():
        return None
    with np.load(path) as data:  # labels: 1 = in scope, 0 = off topic
        return data["vectors"], data["labels"]


def judge(question: str, vector: np.ndarray | None, relevance: float, follow_up: bool = False) -> tuple[bool, float]:
    """(in scope?, how much closer the off-topic examples are). Without an embedding it lets the question through —
    Gates 3 and 4 still apply. Questions naming one of his pages always pass; follow-ups ("and the results?") need
    twice the margin: they're short and lean on the chat."""
    loaded = bank()
    if vector is None or loaded is None or names_a_page(question):
        return True, 0.0
    vectors, labels = loaded
    sims = vectors @ vector
    top = lambda label: float(np.sort(sims[labels == label])[-3:].mean())  # noqa: E731 — mean of the 3 nearest
    gap = top(0) - top(1)
    margin = (ABOUT_HIM_MARGIN if re.search(ABOUT_HIM, question, re.I) else MARGIN) * (2 if follow_up else 1)
    return not (gap > margin and relevance < RELEVANT), round(gap, 3)
