import SwiftUI

/// Individual tab view with icon, title, close button, and dirty indicator
struct TabItemView: View {
    let tab: TabItem
    let isSelected: Bool
    let allowRename: Bool
    let allowClose: Bool
    let onSelect: () -> Void
    let onClose: () -> Void
    let onRename: (String) -> Void

    @State private var isHovered = false
    @State private var isCloseHovered = false
    @State private var isRenaming = false
    @State private var draftTitle = ""
    @FocusState private var renameFocused: Bool

    var body: some View {
        HStack(spacing: TabBarMetrics.contentSpacing) {
            // The selectable / renamable region. The close button is deliberately
            // NOT inside it: an ancestor tap gesture (especially the double-click
            // rename) competes with the close Button for every click and makes it
            // fire only intermittently. Keeping the gestures off the button is
            // what makes closing reliable.
            selectableContent

            // Close button or dirty indicator, with no select/rename gesture over
            // it.
            closeOrDirtyIndicator
        }
        .padding(.horizontal, TabBarMetrics.tabHorizontalPadding)
        .offset(y: isSelected ? 0.5 : 0)
        .frame(
            minWidth: TabBarMetrics.tabMinWidth,
            maxWidth: TabBarMetrics.tabMaxWidth,
            minHeight: TabBarMetrics.tabHeight,
            maxHeight: TabBarMetrics.tabHeight
        )
        .padding(.bottom, isSelected ? 1 : 0)
        .background(tabBackground)
        .contentShape(Rectangle())
        .contextMenu {
            if allowRename {
                Button("Rename") { beginRename() }
            }
            if allowClose {
                Button("Close Tab") { onClose() }
            }
        }
        .onHover { hovering in
            withAnimation(.easeInOut(duration: TabBarMetrics.hoverDuration)) {
                isHovered = hovering
            }
        }
        .accessibilityElement(children: .combine)
        .accessibilityLabel(tab.title)
        .accessibilityValue(tab.isDirty ? "Modified" : "")
        .accessibilityAddTraits(isSelected ? [.isButton, .isSelected] : .isButton)
    }

    // MARK: - Selectable content

    /// Icon plus title (or the rename field), carrying the select and rename
    /// gestures. Uses `simultaneousGesture` so a single click selects at once
    /// instead of waiting out the double-click window, while a double click still
    /// renames. Both are gated on `!isRenaming` so clicks inside the text field
    /// position the caret instead of re-triggering.
    @ViewBuilder
    private var selectableContent: some View {
        HStack(spacing: TabBarMetrics.contentSpacing) {
            if let iconName = tab.icon {
                Image(systemName: iconName)
                    .font(.system(size: TabBarMetrics.iconSize))
                    .foregroundStyle(isSelected ? TabBarColors.activeText : TabBarColors.inactiveText)
            }

            if isRenaming {
                TextField("", text: $draftTitle)
                    .textFieldStyle(.plain)
                    .font(.system(size: TabBarMetrics.titleFontSize))
                    .foregroundStyle(TabBarColors.activeText)
                    .focused($renameFocused)
                    .onSubmit(commitRename)
                    .onExitCommand(perform: cancelRename)
                    // Losing focus commits, which is what every other in-place
                    // rename on this platform does (Finder, Xcode, the sidebar).
                    .onChange(of: renameFocused) { _, focused in
                        if !focused { commitRename() }
                    }
            } else {
                Text(tab.title)
                    .font(.system(size: TabBarMetrics.titleFontSize))
                    .lineLimit(1)
                    .foregroundStyle(isSelected ? TabBarColors.activeText : TabBarColors.inactiveText)
            }

            Spacer(minLength: 4)
        }
        .contentShape(Rectangle())
        .simultaneousGesture(TapGesture(count: 2).onEnded {
            if !isRenaming { beginRename() }
        })
        .simultaneousGesture(TapGesture(count: 1).onEnded {
            if !isRenaming { onSelect() }
        })
    }

    // MARK: - Rename

    private func beginRename() {
        guard allowRename else {
            onSelect()
            return
        }
        onSelect()
        draftTitle = tab.title
        isRenaming = true
        renameFocused = true
    }

    private func commitRename() {
        guard isRenaming else { return }
        isRenaming = false
        let trimmed = draftTitle.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty, trimmed != tab.title else { return }
        onRename(trimmed)
    }

    private func cancelRename() {
        isRenaming = false
        draftTitle = tab.title
    }

    // MARK: - Tab Background

    @ViewBuilder
    private var tabBackground: some View {
        ZStack(alignment: .top) {
            // Background fill
            if isSelected {
                Rectangle()
                    .fill(TabBarColors.activeTabBackground)
            } else if isHovered {
                Rectangle()
                    .fill(TabBarColors.hoveredTabBackground)
            } else {
                Color.clear
            }

            // Top accent indicator for selected tab
            if isSelected {
                Rectangle()
                    .fill(Color.accentColor)
                    .frame(height: TabBarMetrics.activeIndicatorHeight)
            }

            // Right border separator
            HStack {
                Spacer()
                Rectangle()
                    .fill(TabBarColors.separator)
                    .frame(width: 1)
            }
        }
    }

    // MARK: - Close Button / Dirty Indicator

    @ViewBuilder
    private var closeOrDirtyIndicator: some View {
        ZStack {
            // Dirty indicator (shown when dirty and not hovering)
            if tab.isDirty && !isHovered && !isCloseHovered {
                Circle()
                    .fill(TabBarColors.dirtyIndicator)
                    .frame(width: TabBarMetrics.dirtyIndicatorSize, height: TabBarMetrics.dirtyIndicatorSize)
            }

            // Close button (shown on hover)
            if isHovered || isCloseHovered {
                Button {
                    onClose()
                } label: {
                    Image(systemName: "xmark")
                        .font(.system(size: TabBarMetrics.closeIconSize, weight: .semibold))
                        .foregroundStyle(isCloseHovered ? TabBarColors.activeText : TabBarColors.inactiveText)
                        .frame(width: TabBarMetrics.closeButtonSize, height: TabBarMetrics.closeButtonSize)
                        .background(
                            Circle()
                                .fill(isCloseHovered ? TabBarColors.hoveredTabBackground : .clear)
                        )
                }
                .buttonStyle(.plain)
                .onHover { hovering in
                    isCloseHovered = hovering
                }
            }
        }
        .frame(width: TabBarMetrics.closeButtonSize, height: TabBarMetrics.closeButtonSize)
        .animation(.easeInOut(duration: TabBarMetrics.hoverDuration), value: isHovered)
        .animation(.easeInOut(duration: TabBarMetrics.hoverDuration), value: isCloseHovered)
    }
}
