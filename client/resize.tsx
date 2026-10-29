import { useRef, useState } from "react";
import { PanResponder, View } from "react-native";
import { touch, useTheme } from "./ui";
import { t } from "../shared/i18n";

export function ResizeGrip({
  width,
  onChange,
  maxWidth,
  onStart,
  onEnd,
}: {
  width: number;
  onChange(width: number): void;
  maxWidth?: number;
  /** Drag began / finished (released or interrupted). */
  onStart?(): void;
  onEnd?(): void;
}) {
  const { colors } = useTheme();
  const [hovered, setHovered] = useState(false);
  const current = useRef({ width, onChange, onStart, onEnd });
  current.current = { width, onChange, onStart, onEnd };
  const startWidth = useRef(width);
  const pan = useRef(
    PanResponder.create({
      onStartShouldSetPanResponder: () => true,
      onPanResponderGrant: () => {
        startWidth.current = current.current.width;
        current.current.onStart?.();
      },
      onPanResponderRelease: () => current.current.onEnd?.(),
      onPanResponderTerminate: () => current.current.onEnd?.(),
      onPanResponderMove: (_e, g) =>
        current.current.onChange(startWidth.current - g.dx),
      onPanResponderTerminationRequest: () => false,
    }),
  ).current;
  return (
    <View
      {...pan.panHandlers}
      accessibilityLabel={t("Drag to resize task details")}
      accessibilityRole="adjustable"
      accessibilityValue={{ min: 340, max: maxWidth, now: width }}
      accessibilityActions={[
        { name: "increment", label: t("Widen task details") },
        { name: "decrement", label: t("Narrow task details") },
      ]}
      onAccessibilityAction={(event) => {
        const name = event.nativeEvent.actionName;
        if (name === "increment" || name === "decrement")
          current.current.onChange(current.current.width + (name === "increment" ? 60 : -60));
      }}
      onPointerEnter={() => setHovered(true)}
      onPointerLeave={() => setHovered(false)}
      style={{
        width: touch ? 16 : 8,
        alignItems: "center",
        cursor: "col-resize",
      } as never}
    >
      <View
        style={{
          flex: 1,
          width: hovered ? 2 : 1,
          backgroundColor: hovered ? colors.foregroundMuted : colors.border,
        }}
      />
    </View>
  );
}
