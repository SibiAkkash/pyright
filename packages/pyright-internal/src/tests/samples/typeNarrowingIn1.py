# This sample tests type narrowing for the "in" operator.

from typing import Literal, Optional, Union
import random


def verify_str(p: str) -> None:
    ...


def verify_int(p: int) -> None:
    ...


def verify_none(p: None) -> None:
    ...


x: Optional[str]
y: Union[int, str]
if random.random() < 0.5:
    x = None
    y = 1
else:
    x = "2"
    y = "2"

if x in ["2"]:
    verify_str(x)

    # This should generate an error because x should
    # be narrowed to a str.
    verify_none(x)

if y in [2]:
    verify_int(y)

    # This should generate an error because y should
    # be narrowed to an int.
    verify_str(y)


def func1(x: Optional[Union[int, str]], y: Literal[1, 2, "b"], b: int):
    if x in (1, 2, "a"):
        reveal_type(x, expected_text="Literal[1, 2, 'a']")

    if x in (1, "2"):
        reveal_type(x, expected_text="Literal[1, '2']")

    if x in (1, None):
        reveal_type(x, expected_text="Literal[1] | None")

    if x in (1, b, "a"):
        reveal_type(x, expected_text="int | Literal['a']")

    if y in (1, b, "a"):
        reveal_type(y, expected_text="Literal[1, 2]")

    if y in (1, "a"):
        reveal_type(y, expected_text="Literal[1]")

    if y in (1, "b"):
        reveal_type(y, expected_text="Literal[1, 'b']")


def func2(a: Literal[1, 2, 3]):
    x = (1, 2)
    if a in x:
        reveal_type(a, expected_text="Literal[1, 2]")
    else:
        reveal_type(a, expected_text="Literal[1, 2, 3]")


def func3(val: str | None, container: frozenset[str]):
    if val in container:
        reveal_type(val, expected_text="str")
    else:
        reveal_type(val, expected_text="str | None")


def func4(val: str | None, container: list[str]):
    if val not in container:
        reveal_type(val, expected_text="str | None")
    else:
        reveal_type(val, expected_text="str")


def func5(x: str | None, y: int | None, z: dict[str, str]):
    if x in z:
        reveal_type(x, expected_text="str")
    else:
        reveal_type(x, expected_text="str | None")

    if y not in z:
        reveal_type(y, expected_text="int | None")
    else:
        reveal_type(y, expected_text="Never")


def func6(x: type):
    if x in (str, int, float, bool):
        reveal_type(x, expected_text="type")
    else:
        reveal_type(x, expected_text="type")


def func7(x: object | bytes, y: str, z: int):
    if x in (y, z):
        reveal_type(x, expected_text="str | int")
    else:
        reveal_type(x, expected_text="object | bytes")
    reveal_type(x, expected_text="str | int | object | bytes")


def func8(x: object):
    if x in ("a", "b", 2, None):
        reveal_type(x, expected_text="Literal['a', 'b', 2] | None")
