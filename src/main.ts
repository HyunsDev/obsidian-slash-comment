import { RangeSetBuilder } from "@codemirror/state";
import {
	Decoration,
	DecorationSet,
	EditorView,
	PluginSpec,
	PluginValue,
	ViewPlugin,
	ViewUpdate,
} from "@codemirror/view";
import { Plugin, editorLivePreviewField } from "obsidian";

// --- Constants ---
const TARGET_TAGS = "p, li, h1, h2, h3, h4, h5, h6, blockquote, th, td, div";
const COMMENT_MARKER = "//";

const CLS = {
	CONTAINER: "cm-slash-comment-container",
	COMMENT: "cm-slash-comment",
	HIDDEN: "cm-slash-hide",
};

const DATA_ATTR = "processedSlashComment";

/*
 * ==============================
 * 1. Reading Mode Logic
 * ==============================
 */

/**
 * Processes a block element to style inline comments.
 * It searches for the comment marker and wraps the remaining text/nodes in a styled container.
 * Stops at <br> tags or newlines to prevent bleeding into the next line.
 */
const processBlock = (el: HTMLElement) => {
	if (el.dataset[DATA_ATTR]) return;

	// Snapshot of child nodes
	const childNodes = Array.from(el.childNodes);

	for (let i = 0; i < childNodes.length; i++) {
		const node = childNodes[i]!;

		if (node.nodeType === Node.TEXT_NODE && node.textContent) {
			const text = node.textContent;
			const matchIndex = text.indexOf(COMMENT_MARKER);

			if (matchIndex !== -1) {
				// 1. Split text node
				const preCommentText = text.substring(0, matchIndex);
				let rawCommentText = text.substring(matchIndex);

				// [Fix] Handle cases where the text node contains a newline (\n)
				// (Comments are valid only up to the newline)
				const newlineIndex = rawCommentText.indexOf("\n");
				let postCommentText = "";
				let hasNewlineInside = false;

				if (newlineIndex !== -1) {
					postCommentText = rawCommentText.substring(newlineIndex); // Preserve text after \n
					rawCommentText = rawCommentText.substring(0, newlineIndex); // Text before \n is the comment
					hasNewlineInside = true;
				}

				// Check if there is a space after // ("// " vs "//text")
				let markerLength = COMMENT_MARKER.length; // 2
				if (rawCommentText.startsWith(COMMENT_MARKER + " ")) {
					markerLength = COMMENT_MARKER.length + 1; // 3
				}

				// Modify original text node (keep only the part before the comment)
				node.textContent = preCommentText;

				// 2. Create comment container
				const containerSpan = document.createElement("span");
				containerSpan.addClass(CLS.CONTAINER);

				// Marker to hide (// or // )
				const hiddenMarker = document.createElement("span");
				hiddenMarker.textContent = rawCommentText.substring(
					0,
					markerLength
				);
				hiddenMarker.addClass(CLS.HIDDEN);
				containerSpan.appendChild(hiddenMarker);

				// Comment content
				const afterMarkerText = document.createElement("span");
				afterMarkerText.textContent =
					rawCommentText.substring(markerLength);
				containerSpan.appendChild(afterMarkerText);

				// 3. Insert container (after original node)
				if (node.nextSibling) {
					el.insertBefore(containerSpan, node.nextSibling);
				} else {
					el.appendChild(containerSpan);
				}

				// 4. [Important] If newline was inside the text node, restore the remaining text after the container
				if (hasNewlineInside) {
					const postTextNode =
						document.createTextNode(postCommentText);
					if (containerSpan.nextSibling) {
						el.insertBefore(
							postTextNode,
							containerSpan.nextSibling
						);
					} else {
						el.appendChild(postTextNode);
					}
					// Since there was a newline, do not move sibling nodes
				} else {
					// 5. Handle sibling nodes (move subsequent nodes into the comment container)
					// Stop if a <br> tag is encountered!
					while (i + 1 < childNodes.length) {
						const nextSibling = childNodes[i + 1];
						if (!nextSibling) {
							i++;
							continue;
						}

						// [Core Fix] Stop processing if a newline tag (<br>) is encountered
						if (nextSibling.nodeName === "BR") {
							break;
						}

						el.removeChild(nextSibling);
						containerSpan.appendChild(nextSibling);
						i++;
					}
				}

				// Continue searching as there might be multiple lines in one block
			}
		} else if (node instanceof HTMLElement) {
			processBlock(node);
		}
	}

	el.dataset[DATA_ATTR] = "true";
};

const updateReadingMode = (element: HTMLElement) => {
	const allowedElems = element.findAll(TARGET_TAGS);
	for (const elem of allowedElems) {
		if (elem instanceof HTMLElement) {
			processBlock(elem);
		}
	}
};

/*
 * ==============================
 * 2. Editor / Live Preview Logic
 * ==============================
 */

const DECORATIONS = {
	CONTENT: Decoration.mark({ class: CLS.COMMENT }),
	HIDDEN: Decoration.mark({ class: CLS.HIDDEN }),
};

class SlashCommentViewPlugin implements PluginValue {
	decorations: DecorationSet;

	constructor(view: EditorView) {
		this.decorations = this.buildDecorations(view);
	}

	update(update: ViewUpdate) {
		if (
			update.docChanged ||
			update.viewportChanged ||
			update.selectionSet
		) {
			this.decorations = this.buildDecorations(update.view);
		}
	}

	destroy() {}

	buildDecorations(view: EditorView): DecorationSet {
		const builder = new RangeSetBuilder<Decoration>();
		const isLivePreview = view.state.field(editorLivePreviewField);
		const selection = view.state.selection;

		for (const { from, to } of view.visibleRanges) {
			for (let pos = from; pos <= to; ) {
				const line = view.state.doc.lineAt(pos);
				const text = line.text;
				const matchIndex = text.indexOf(COMMENT_MARKER);

				if (matchIndex >= 0) {
					const start = line.from + matchIndex;
					const end = line.to;

					let hideLength = COMMENT_MARKER.length; // 2
					if (text[matchIndex + COMMENT_MARKER.length] === " ") {
						hideLength = COMMENT_MARKER.length + 1; // 3
					}

					const isCursorOnLine = selection.ranges.some(
						(range) =>
							range.to >= line.from && range.from <= line.to
					);

					if (isLivePreview && !isCursorOnLine) {
						builder.add(
							start,
							start + hideLength,
							DECORATIONS.HIDDEN
						);

						if (start + hideLength < end) {
							builder.add(
								start + hideLength,
								end,
								DECORATIONS.CONTENT
							);
						}
					} else {
						builder.add(start, end, DECORATIONS.CONTENT);
					}
				}
				pos = line.to + 1;
			}
		}
		return builder.finish();
	}
}

const pluginSpec: PluginSpec<SlashCommentViewPlugin> = {
	decorations: (value: SlashCommentViewPlugin) => value.decorations,
};

const commentEditorPlugin = ViewPlugin.fromClass(
	SlashCommentViewPlugin,
	pluginSpec
);

/*
 * ==============================
 * 3. Main Plugin Definition
 * ==============================
 */

export default class SlashCommentPlugin extends Plugin {
	async onload() {
		this.registerEditorExtension(commentEditorPlugin);
		this.registerMarkdownPostProcessor((element) => {
			updateReadingMode(element);
		});
	}
}
